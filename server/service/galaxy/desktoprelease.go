package galaxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 桌面客户端（Nova 共享端 / Orbit 使用端）的发版与分发。
//
// 客户端那一侧是 electron-updater：应用按平台去 OSS 上取一个固定文件名的清单
// （latest-mac.yml / latest.yml / latest-linux.yml），比版本号，下载清单里指的包，
// 校验 sha512，装上。**它不经过我们的任何接口** —— 清单和包都在公开读的 OSS 目录里。
//
// 所以这里做的事只有两件：
//
//  1. 让运营把 electron-builder 出的那几个文件传上去（包一百多兆，浏览器拿签名地址
//     直传，服务端一个字节都不经手）；
//  2. 决定「现在这个通道对外的清单是哪一份」—— 也就是 syncDesktopChannel：
//     把「版本最高的、还在架上的那一行」的清单原文写到固定路径上。
//
// 下架因此是有意义的：把清单换回上一版，新的检查就不会再指向那个包（已经装上的机器
// 不受影响 —— 桌面应用不会自己降级）。

const (
	// OSS 上的落点是 <oss.dirPrefix>/<端>/<文件名> —— 端目录直接挂在部署前缀下，
	// 和 ai-bridge 的包（<dirPrefix>/ai-bridge/…）是平级的：它们本来就是同一类东西，
	// 「某个客户端的安装包」。中间不再多一层 desktop/，那一层除了让人多点一次没有作用。
	//
	// 端目录里**平铺**，不按版本分子目录：electron-updater 是拿**清单所在目录**
	// 去拼清单里的文件名的，包放进子目录就要改写清单里的 path/url，
	// 而那份清单恰恰是我们最不该改的东西（它是 electron-builder 的产物）。
	// 文件名自带版本号，不会撞。

	// desktopUploadTTL 直传地址的有效期。给两小时不是随手写的：一百多兆的包
	// 走一条几兆的上行要十几分钟，运营还可能选完文件去接个电话。
	desktopUploadTTL = 2 * time.Hour

	// maxDesktopManifestBytes 清单是几百字节的 yml，给到 64KB 已经是几十倍余量。
	maxDesktopManifestBytes = 64 << 10

	// maxDesktopFileBytes 单个安装包的上限。Electron 应用一百多兆，留到 2GB。
	maxDesktopFileBytes = 2 << 30

	// maxDesktopFiles 一份清单里最多几个文件（mac 是 zip + dmg，win 一个 exe）。
	maxDesktopFiles = 8
)

// desktopProducts 两个端，页面上的顺序也按它。
var desktopProducts = []string{"nova", "orbit"}

// desktopManifestFiles 通道 → 清单文件名。名字是 electron-updater 定死的：
// 它按运行平台拼 `<channel><平台后缀>.yml` 去取，取不到就是「没有可用更新」。
var desktopManifestFiles = map[string]string{
	dto.DesktopChannelMac:   "latest-mac.yml",
	dto.DesktopChannelWin:   "latest.yml",
	dto.DesktopChannelLinux: "latest-linux.yml",
}

// desktopChannels 页面上的固定顺序。
var desktopChannels = []string{dto.DesktopChannelMac, dto.DesktopChannelWin, dto.DesktopChannelLinux}

var desktopVersionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)

// desktopFileNamePattern 清单里的文件名。卡得比「合法对象键」严：
// 它同时是 OSS 上的对象名和清单里的下载路径，带空格或中文就要谈转义，
// 而两边的转义规则不一样。打包时的 artifactName 已经保证是这个形状。
var desktopFileNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// desktopManifest 是 electron-builder 写出来的 latest-*.yml，解析出来只为了校验与登记。
// **写回 OSS 的不是它**，是原文（见 desktopDocument）—— 那份 yml 的字段会随
// electron-builder 变，拆成结构体再拼回去等于我们要跟着它的格式走一辈子。
type desktopManifest struct {
	Version string                `yaml:"version"`
	Files   []desktopManifestFile `yaml:"files"`
	Path    string                `yaml:"path"`
	SHA512  string                `yaml:"sha512"`
}

type desktopManifestFile struct {
	URL    string `yaml:"url"`
	SHA512 string `yaml:"sha512"`
	Size   int64  `yaml:"size"`
}

// desktopDocument 解析好的一份清单：原文的节点树（改完 releaseNotes 还要写回去）
// 加上校验用的结构体。
type desktopDocument struct {
	node     *yaml.Node
	manifest desktopManifest
}

// parseDesktopManifest 解析并校验 electron-builder 出的清单。
//
// 校验的每一条都对应一种「发布看着成功、客户端却更新不了」的故障，
// 而那种故障要等用户那边不更新才被发现：
func parseDesktopManifest(raw, channel string) (*desktopDocument, error) {
	if len(raw) == 0 {
		return nil, errors.New("清单是空的")
	}
	if len(raw) > maxDesktopManifestBytes {
		return nil, fmt.Errorf("清单超过 %d KB，这多半不是 latest-*.yml", maxDesktopManifestBytes>>10)
	}
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(raw), &doc); err != nil {
		return nil, fmt.Errorf("清单不是合法的 yml：%w", err)
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("清单的顶层不是一组键值，这不是 electron-builder 出的 latest-*.yml")
	}
	var manifest desktopManifest
	if err := doc.Content[0].Decode(&manifest); err != nil {
		return nil, fmt.Errorf("清单解析失败：%w", err)
	}
	manifest.Version = strings.TrimSpace(manifest.Version)
	if !desktopVersionPattern.MatchString(manifest.Version) {
		return nil, fmt.Errorf("清单里的版本号不是语义版本：%q", manifest.Version)
	}
	if len(manifest.Files) == 0 {
		return nil, errors.New("清单里一个文件都没有")
	}
	if len(manifest.Files) > maxDesktopFiles {
		return nil, fmt.Errorf("清单里有 %d 个文件，超出上限 %d", len(manifest.Files), maxDesktopFiles)
	}
	seen := map[string]bool{}
	for index := range manifest.Files {
		file := &manifest.Files[index]
		file.URL = strings.TrimSpace(file.URL)
		if !desktopFileNamePattern.MatchString(file.URL) {
			return nil, fmt.Errorf("清单里的文件名不能带路径或空格：%q", file.URL)
		}
		if seen[file.URL] {
			return nil, fmt.Errorf("清单里有两个同名文件：%q", file.URL)
		}
		seen[file.URL] = true
		if file.Size <= 0 || file.Size > maxDesktopFileBytes {
			return nil, fmt.Errorf("%s 的大小不对：%d", file.URL, file.Size)
		}
		if strings.TrimSpace(file.SHA512) == "" {
			return nil, fmt.Errorf("%s 没有 sha512 —— 客户端下载完就是靠它校验的", file.URL)
		}
	}
	// path 是客户端真正要装的那一个。它指向一个清单里没有的文件时，
	// 下载那一步会 404，而检查更新那一步一切正常。
	if manifest.Path = strings.TrimSpace(manifest.Path); manifest.Path != "" && !seen[manifest.Path] {
		return nil, fmt.Errorf("清单的 path 指向 %q，但 files 里没有这个文件", manifest.Path)
	}
	// 各平台真正装得上的那种包。少了它，更新会一路走到最后一步才失败：
	// mac 上 Squirrel 只吃 zip（dmg 是给人手动装的），windows 装的是 exe。
	if err := requireDesktopArtifact(channel, manifest.Files); err != nil {
		return nil, err
	}
	return &desktopDocument{node: &doc, manifest: manifest}, nil
}

func requireDesktopArtifact(channel string, files []desktopManifestFile) error {
	has := func(suffixes ...string) bool {
		for _, file := range files {
			for _, suffix := range suffixes {
				if strings.HasSuffix(strings.ToLower(file.URL), suffix) {
					return true
				}
			}
		}
		return false
	}
	switch channel {
	case dto.DesktopChannelMac:
		if !has(".zip") {
			return errors.New("mac 的清单里必须有 .zip：Squirrel 只认 zip，dmg 是给人手动装的")
		}
	case dto.DesktopChannelWin:
		if !has(".exe") {
			return errors.New("windows 的清单里必须有 .exe 安装包")
		}
	}
	// linux 的包型（AppImage / deb / rpm / pacman）由客户端按自己的安装方式挑，
	// 这里不替它决定 —— 卡死一种只会让换了打包方式的人过不来。
	return nil
}

// setDesktopNotes 把运营写的版本说明塞进清单的 releaseNotes。
//
// 客户端的更新提示上显示的就是它（common/electron/update/runtime.ts 的 releaseNotes）。
// 在节点树上改而不是重新序列化整个结构体：清单里别的字段（blockMapSize、
// minimumSystemVersion、packages…）跟着 electron-builder 走，我们不认识的也要原样留着。
func setDesktopNotes(doc *desktopDocument, notes string) error {
	root := doc.node.Content[0]
	notes = strings.TrimSpace(notes)
	for index := 0; index+1 < len(root.Content); index += 2 {
		if root.Content[index].Value != "releaseNotes" {
			continue
		}
		if notes == "" {
			// 说明清空了就把这个键去掉，而不是留一个空串 —— 客户端拿空串会画一块空的「更新内容」。
			root.Content = append(root.Content[:index], root.Content[index+2:]...)
			return nil
		}
		root.Content[index+1] = desktopNotesNode(notes)
		return nil
	}
	if notes == "" {
		return nil
	}
	key := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "releaseNotes"}
	root.Content = append(root.Content, key, desktopNotesNode(notes))
	return nil
}

// desktopNotesNode 版本说明可能有好几行。用字面量块（|-）而不是普通标量：
// 普通标量里的换行会被 yml 折成空格，客户端上看到的就是挤成一行的说明。
func desktopNotesNode(notes string) *yaml.Node {
	node := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: notes}
	if strings.Contains(notes, "\n") {
		node.Style = yaml.LiteralStyle
	}
	return node
}

// PrepareDesktopRelease 发版第一步：收下清单，登记这一版，回几个直传地址。
//
// 字节不经服务端：包一百多兆，而管理端浏览器到这里中间还隔着 Next.js 的通配代理
// （那条路只转发 JSON）。所以这里只签地址，包由浏览器自己 PUT 上 OSS。
func (s *service) PrepareDesktopRelease(ctx context.Context, req dto.PrepareDesktopReleaseRequest) (dto.DesktopReleaseUpload, error) {
	if s.desktop == nil {
		return dto.DesktopReleaseUpload{}, errors.New("对象存储未配置，桌面客户端发版不可用（oss.*）")
	}
	product, err := desktopProduct(req.Product)
	if err != nil {
		return dto.DesktopReleaseUpload{}, err
	}
	channel, err := desktopChannelOf(req.FileName)
	if err != nil {
		return dto.DesktopReleaseUpload{}, err
	}
	doc, err := parseDesktopManifest(req.Manifest, channel)
	if err != nil {
		return dto.DesktopReleaseUpload{}, err
	}
	notes := truncate(strings.TrimSpace(req.Notes), 2000)
	if err := setDesktopNotes(doc, notes); err != nil {
		return dto.DesktopReleaseUpload{}, err
	}
	manifest, err := yaml.Marshal(doc.node)
	if err != nil {
		return dto.DesktopReleaseUpload{}, fmt.Errorf("清单写不回去：%w", err)
	}

	now := time.Now()
	releaseID := "dr_" + NewULID(now)
	existing, err := s.repository.FindDesktopReleaseTarget(ctx, bizLine, product, channel, doc.manifest.Version)
	switch {
	case err == nil && existing.Status == dto.DesktopPublished:
		// 覆盖一个在架的版本，等于让已经更新过的人和还没更新的人拿到两份不同的字节，
		// 而版本号还是同一个。要重发就先下架 —— 这一步是故意让人多想一下。
		return dto.DesktopReleaseUpload{}, fmt.Errorf("%s 的 %s %s 已经发布过了：先下架再重新上传", product, channel, doc.manifest.Version)
	case err == nil:
		releaseID = existing.ReleaseID
	case !notFound(err):
		return dto.DesktopReleaseUpload{}, err
	}

	files := make([]dto.DesktopReleaseFile, 0, len(doc.manifest.Files))
	uploads := make([]dto.DesktopReleaseUploadTarget, 0, len(doc.manifest.Files))
	expiresAt := now.Add(desktopUploadTTL)
	var total int64
	for _, file := range doc.manifest.Files {
		contentType := desktopContentType(file.URL)
		url, err := s.desktop.SignedPutURL(desktopObjectKey(s.desktop, product, file.URL), contentType, expiresAt)
		if err != nil {
			return dto.DesktopReleaseUpload{}, fmt.Errorf("签发上传地址失败：%w", err)
		}
		files = append(files, dto.DesktopReleaseFile{Name: file.URL, Size: file.Size, SHA512: file.SHA512})
		uploads = append(uploads, dto.DesktopReleaseUploadTarget{Name: file.URL, Size: file.Size, ContentType: contentType, URL: url})
		total += file.Size
	}
	filesJSON, err := json.Marshal(files)
	if err != nil {
		return dto.DesktopReleaseUpload{}, err
	}
	row := &repository.GalaxyDesktopRelease{
		BizLine: bizLine, ReleaseID: releaseID, Product: product, Channel: channel,
		Version: doc.manifest.Version, ManifestFile: desktopManifestFiles[channel], Manifest: string(manifest),
		FilesJSON: string(filesJSON), Size: total, Notes: notes,
		// 先停在 staging：包还没传上去，这一版对客户端还不存在。
		Status: dto.DesktopStaging, PublishedBy: req.Operator,
	}
	if err := s.repository.SaveDesktopRelease(ctx, row); err != nil {
		return dto.DesktopReleaseUpload{}, err
	}
	return dto.DesktopReleaseUpload{
		ReleaseID: releaseID, Product: product, Channel: channel, Version: doc.manifest.Version,
		Uploads: uploads, ExpiresAt: expiresAt,
	}, nil
}

// PublishDesktopRelease 发版第二步：确认包真的在 OSS 上了，再把清单发出去。
//
// 那一次 HEAD 不是多余的。字节不经服务端，「传完了没有」只有对象存储知道；
// 少了它，一份指向不存在文件的清单会被发布出去 —— 检查更新一切正常，
// 每一台机器都在下载那一步 404，而运营这边显示的是「发布成功」。
func (s *service) PublishDesktopRelease(ctx context.Context, req dto.PublishDesktopReleaseRequest) (dto.DesktopReleaseView, error) {
	if s.desktop == nil {
		return dto.DesktopReleaseView{}, errors.New("对象存储未配置，桌面客户端发版不可用（oss.*）")
	}
	row, err := s.repository.FindDesktopRelease(ctx, bizLine, strings.TrimSpace(req.ReleaseID))
	if notFound(err) {
		return dto.DesktopReleaseView{}, errors.New("这一版不存在，请重新上传")
	}
	if err != nil {
		return dto.DesktopReleaseView{}, err
	}
	files := desktopFilesOf(row)
	for _, file := range files {
		size, found, err := s.desktop.Stat(ctx, desktopObjectKey(s.desktop, row.Product, file.Name))
		if err != nil {
			return dto.DesktopReleaseView{}, fmt.Errorf("确认 %s 是否上传成功时出错：%w", file.Name, err)
		}
		if !found {
			return dto.DesktopReleaseView{}, fmt.Errorf("%s 还没有传上去，清单发出去也下载不到", file.Name)
		}
		// size 为 0 是「网关没给 Content-Length」，不是「传了个空文件」（OSS 的 HEAD 一定带长度）。
		if size > 0 && size != file.Size {
			return dto.DesktopReleaseView{}, fmt.Errorf("%s 传上去的是 %d 字节，清单里写的是 %d 字节：重新传一次", file.Name, size, file.Size)
		}
	}
	now := time.Now()
	if _, err := s.repository.SetDesktopReleaseStatus(ctx, bizLine, row.ReleaseID, dto.DesktopPublished, &now, req.Operator); err != nil {
		return dto.DesktopReleaseView{}, err
	}
	row.Status, row.PublishedAt, row.PublishedBy = dto.DesktopPublished, &now, req.Operator
	current, err := s.syncDesktopChannel(ctx, row.Product, row.Channel)
	if err != nil {
		return dto.DesktopReleaseView{}, err
	}
	// 补发一个更旧的版本是允许的（历史归档），但它不会顶掉更高的那一版 ——
	// 页面上要照实说，不能一律回一句「已发布，客户端马上就会提示更新」。
	return desktopReleaseView(row, current != nil && current.ReleaseID == row.ReleaseID), nil
}

// SetDesktopReleaseStatus 下架 / 重新上架。
//
// 下架不删包：已经装上它的人不受影响（桌面应用不会自己降级），OSS 上的文件也留着 ——
// 改的只是「对外的那份清单指向谁」：下架当前这一版之后，清单换回上一个在架的版本；
// 一个在架的都不剩时，把清单从 OSS 上删掉（宁可让客户端查不到更新，
// 也不能让它继续装一个已经被判有问题的包）。
func (s *service) SetDesktopReleaseStatus(ctx context.Context, req dto.SetDesktopReleaseStatusRequest) error {
	if s.desktop == nil {
		return errors.New("对象存储未配置，桌面客户端发版不可用（oss.*）")
	}
	status := strings.TrimSpace(req.Status)
	if status != dto.DesktopPublished && status != dto.DesktopWithdrawn {
		return fmt.Errorf("状态只能是 %s 或 %s", dto.DesktopPublished, dto.DesktopWithdrawn)
	}
	row, err := s.repository.FindDesktopRelease(ctx, bizLine, strings.TrimSpace(req.ReleaseID))
	if notFound(err) {
		return errors.New("这一版不存在")
	}
	if err != nil {
		return err
	}
	if status == dto.DesktopPublished && row.Status == dto.DesktopStaging {
		// staging 的行还没确认过文件在不在，不能从这里直接上架 —— 那条路在 PublishDesktopRelease。
		return errors.New("这一版还没上传完，请回到上传流程把包传完")
	}
	var publishedAt *time.Time
	if status == dto.DesktopPublished {
		now := time.Now()
		publishedAt = &now
	}
	found, err := s.repository.SetDesktopReleaseStatus(ctx, bizLine, row.ReleaseID, status, publishedAt, req.Operator)
	if err != nil {
		return err
	}
	if !found {
		return errors.New("这一版不存在")
	}
	_, err = s.syncDesktopChannel(ctx, row.Product, row.Channel)
	return err
}

// ListDesktopReleases 运营列表：全部，含待上传与已下架的，版本新的在前。
func (s *service) ListDesktopReleases(ctx context.Context) (dto.DesktopReleasePage, error) {
	rows, err := s.repository.ListDesktopReleases(ctx, bizLine, "", false)
	if err != nil {
		return dto.DesktopReleasePage{}, err
	}
	current := map[string]string{}
	for _, row := range rows {
		if row.Status != dto.DesktopPublished {
			continue
		}
		key := row.Product + "/" + row.Channel
		if best, ok := current[key]; !ok || compareBridgeVersions(row.Version, best) > 0 {
			current[key] = row.Version
		}
	}
	sortDesktopReleases(rows)
	page := dto.DesktopReleasePage{
		Releases: make([]dto.DesktopReleaseView, 0, len(rows)),
		Products: desktopProducts,
		Channels: desktopChannels,
	}
	if s.desktop != nil {
		// 两个端目录的**父目录**（也就是部署配置的 dirPrefix，没配就是桶根）。
		// 运营拿它拼客户端的更新地址，所以由服务端给：前端自己拼必然漏掉 dirPrefix，
		// 而漏掉之后客户端取清单是 404。
		page.Configured, page.ObjectRoot = true, s.desktop.ResolveKey("")
	}
	for _, row := range rows {
		isCurrent := row.Status == dto.DesktopPublished && current[row.Product+"/"+row.Channel] == row.Version
		page.Releases = append(page.Releases, desktopReleaseView(row, isCurrent))
	}
	return page, nil
}

// syncDesktopChannel 把「这个端这个通道当前对外的清单」写到固定路径上，
// 并返回刚写出去的是哪一行（一个在架的都没有时是 nil）。
//
// 客户端只认那一个地址，所以这个函数就是**发布这件事本身**：上架、下架、
// 发一个更高的版本，最后都归到这里重算一次「谁是当前版本」。
func (s *service) syncDesktopChannel(ctx context.Context, product, channel string) (*repository.GalaxyDesktopRelease, error) {
	rows, err := s.repository.ListDesktopReleases(ctx, bizLine, product, true)
	if err != nil {
		return nil, err
	}
	var current *repository.GalaxyDesktopRelease
	for _, row := range rows {
		if row.Channel != channel {
			continue
		}
		if current == nil || compareBridgeVersions(row.Version, current.Version) > 0 {
			current = row
		}
	}
	key := desktopObjectKey(s.desktop, product, desktopManifestFiles[channel])
	if current == nil {
		// 一个在架的都不剩：把清单撤下来。宁可让客户端查不到更新，
		// 也不能让它继续装一个已经被判有问题的包。
		if err := s.desktop.Delete(ctx, key); err != nil {
			return nil, fmt.Errorf("撤下清单失败：%w", err)
		}
		return nil, nil
	}
	if _, err := s.desktop.PutObject(ctx, key, "text/yaml; charset=utf-8", []byte(current.Manifest), ""); err != nil {
		return nil, fmt.Errorf("写清单失败：%w", err)
	}
	return current, nil
}

// desktopObjectKey 这个端这个文件的真正对象键：<dirPrefix>/<端>/<文件名>。
//
// 清单由服务端写、安装包由浏览器拿签名地址直传，两条路在这里对齐成同一套键 ——
// 不对齐的话它们会安静地落在两个目录里：发布成功，客户端 404。
//
// 参数收窄到 keyResolver 而不是整个 DesktopStore：这个函数只需要那一个方法，
// 收窄之后用例里给一个两行的桩就能把「前缀有没有带上」钉住。
func desktopObjectKey(store keyResolver, product, name string) string {
	return store.ResolveKey(path.Join(product, name))
}

type keyResolver interface {
	ResolveKey(objectKey string) string
}

func desktopProduct(raw string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	for _, product := range desktopProducts {
		if product == value {
			return product, nil
		}
	}
	return "", fmt.Errorf("不认识的端 %q（认识的：%s）", raw, strings.Join(desktopProducts, "、"))
}

// desktopChannelOf 从清单文件名认平台通道。名字是 electron-updater 定死的，
// 所以这里不接受别的写法 —— 传错文件（比如把 builder-debug.yml 拖进来）当场就能说清楚。
func desktopChannelOf(fileName string) (string, error) {
	name := strings.TrimSpace(fileName)
	for channel, expected := range desktopManifestFiles {
		if name == expected {
			return channel, nil
		}
	}
	return "", fmt.Errorf("清单文件名必须是 latest-mac.yml / latest.yml / latest-linux.yml 之一，收到 %q", fileName)
}

// desktopContentType 上传时带的类型。它参与签名，客户端必须原样带上，
// 所以由服务端定 —— 让浏览器自己按文件后缀猜，同一个 .AppImage 在不同系统上
// 猜出来的类型不一样，签名就对不上。
func desktopContentType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".zip":
		return "application/zip"
	case ".dmg":
		return "application/x-apple-diskimage"
	case ".yml", ".yaml":
		return "text/yaml; charset=utf-8"
	default:
		// exe / AppImage / deb / rpm / blockmap 一律按字节流传。
		return "application/octet-stream"
	}
}

func desktopFilesOf(row *repository.GalaxyDesktopRelease) []dto.DesktopReleaseFile {
	var files []dto.DesktopReleaseFile
	if strings.TrimSpace(row.FilesJSON) == "" {
		return files
	}
	if err := json.Unmarshal([]byte(row.FilesJSON), &files); err != nil {
		return nil
	}
	return files
}

// sortDesktopReleases 端按固定顺序，同一个端里版本新的在前，同版本按通道的固定顺序。
func sortDesktopReleases(rows []*repository.GalaxyDesktopRelease) {
	rank := func(values []string, value string) int {
		for index, item := range values {
			if item == value {
				return index
			}
		}
		return len(values)
	}
	sort.SliceStable(rows, func(left, right int) bool {
		if rows[left].Product != rows[right].Product {
			return rank(desktopProducts, rows[left].Product) < rank(desktopProducts, rows[right].Product)
		}
		if cmp := compareBridgeVersions(rows[left].Version, rows[right].Version); cmp != 0 {
			return cmp > 0
		}
		return rank(desktopChannels, rows[left].Channel) < rank(desktopChannels, rows[right].Channel)
	})
}

func desktopReleaseView(row *repository.GalaxyDesktopRelease, current bool) dto.DesktopReleaseView {
	return dto.DesktopReleaseView{
		ReleaseID: row.ReleaseID, Product: row.Product, Channel: row.Channel, Version: row.Version,
		ManifestFile: row.ManifestFile, Files: desktopFilesOf(row), Size: row.Size, Notes: row.Notes,
		Status: row.Status, Current: current, PublishedBy: row.PublishedBy, PublishedAt: row.PublishedAt,
		CreatedAt: row.CreatedTime, UpdatedAt: row.UpdatedTime,
	}
}
