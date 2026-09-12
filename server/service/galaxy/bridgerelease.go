package galaxy

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// ai-bridge 安装包的发布与分发。
//
// 运营在管理端上传包，字节进 OSS，这里只留元数据；控制台与安装脚本从这里取
// 「装哪一个、怎么验」。节点远程升级时下发的也是同一份元数据（见 nodeupgrade.go）。

const (
	bridgePublished = "published"
	bridgeWithdrawn = "withdrawn"

	// maxBridgePackageBytes 上传上限。当前的包 3 MB 上下，留出几十倍的余量；
	// 再大就不是包变胖，而是传错了东西。
	maxBridgePackageBytes = 64 << 20

	// bridgeObjectPrefix OSS 上的落点：<prefix>/ai-bridge/<版本>/<文件名>。
	// 按版本分目录，下架之后对象仍在原处 —— 装过这一版的机器还要能对得上。
	bridgeObjectPrefix = "ai-bridge"
)

// bridgePlatforms 是认识的平台名与它们在下载页上的顺序。
//
// Linux 在最前面：共享算力的机器绝大多数是服务器。顺序固定在服务端，
// 免得两个客户端各排各的，用户在不同地方看到的清单不一样。
var bridgePlatforms = []string{
	"linux-x64", "linux-arm64",
	"darwin-arm64", "darwin-x64",
	"windows-x64", "windows-arm64",
}

// bridgePackagePattern 包名的唯一形状，和 scripts/build-cli.cjs 打出来的一致。
var bridgePackagePattern = regexp.MustCompile(`^ai-bridge-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-([a-z0-9]+-[a-z0-9]+)\.(tar\.gz|zip)$`)

func knownBridgePlatform(platform string) bool {
	for _, known := range bridgePlatforms {
		if known == platform {
			return true
		}
	}
	return false
}

// ParseBridgePackageName 从包名里解析版本与平台。
//
// 版本和平台只从文件名来，不让上传方另填一遍：两处各填一次，迟早会出现
// 「文件名是 0.2.0、登记成 0.2.1」的包，而节点是按登记的版本去比对新旧的。
func ParseBridgePackageName(fileName string) (version, platform string, err error) {
	name := strings.TrimSpace(fileName)
	match := bridgePackagePattern.FindStringSubmatch(name)
	if match == nil {
		return "", "", fmt.Errorf("包名必须是 ai-bridge-<版本>-<平台>.tar.gz（windows 是 .zip），收到 %q", name)
	}
	version, platform, suffix := match[1], match[2], match[3]
	if !knownBridgePlatform(platform) {
		return "", "", fmt.Errorf("不认识的平台 %q（认识的：%s）", platform, strings.Join(bridgePlatforms, "、"))
	}
	// 后缀要和平台对得上：Windows 上没有 tar.gz 的解压习惯，其余平台也不发 zip。
	// 错了的话节点会下载成功、解包失败 —— 那种失败发生在最后一步，排查成本高得多。
	windows := strings.HasPrefix(platform, "windows-")
	if windows && suffix != "zip" {
		return "", "", fmt.Errorf("%s 的包应当是 .zip", platform)
	}
	if !windows && suffix != "tar.gz" {
		return "", "", fmt.Errorf("%s 的包应当是 .tar.gz", platform)
	}
	return version, platform, nil
}

// compareBridgeVersions 比较两个语义版本：负数 a 更旧、0 相同、正数 a 更新。
//
// 不能按字符串比：那样 "0.10.0" 比 "0.9.0" 小，一次小版本号进位就会让所有机器
// 认为自己已经是最新的。带预发布后缀的一律**低于**同号正式版（0.2.0-rc1 < 0.2.0）。
func compareBridgeVersions(left, right string) int {
	leftCore, leftPre := splitBridgeVersion(left)
	rightCore, rightPre := splitBridgeVersion(right)
	for index := 0; index < 3; index++ {
		if leftCore[index] != rightCore[index] {
			if leftCore[index] < rightCore[index] {
				return -1
			}
			return 1
		}
	}
	switch {
	case leftPre == rightPre:
		return 0
	case leftPre == "":
		return 1
	case rightPre == "":
		return -1
	case leftPre < rightPre:
		return -1
	default:
		return 1
	}
}

// splitBridgeVersion 拆成三段数字与预发布后缀。解析不出来的段按 0 ——
// 版本号在上传时已经按正则卡过，这里不需要再报一次错。
func splitBridgeVersion(version string) ([3]int64, string) {
	var core [3]int64
	value := strings.TrimSpace(version)
	pre := ""
	if index := strings.IndexByte(value, '-'); index >= 0 {
		value, pre = value[:index], value[index+1:]
	}
	for index, part := range strings.SplitN(value, ".", 3) {
		if index > 2 {
			break
		}
		core[index], _ = strconv.ParseInt(part, 10, 64)
	}
	return core, pre
}

// bridgeSignedMessage 被签名的字节。节点侧逐字节按同一个形状拼（upgrade.rs），
// 差一个换行两边就永远对不上，所以这段格式在两处都写死、都有测试钉着。
func bridgeSignedMessage(version, platform, digest string) []byte {
	return []byte("ai-bridge-release:v1\n" + version + "\n" + platform + "\n" + digest + "\n")
}

// verifyBridgeSignature 用配置里的发布公钥验一遍。任何一把验过就算数（允许换钥匙期间新旧并存）。
//
// 服务端**也**验，不是只靠节点：验不过的包发上去，每一台机器都会在升级的最后一步
// 拒装，而运营要到那时候才知道自己传错了东西。
func verifyBridgeSignature(keys []string, version, platform, digest, signature string) error {
	if len(keys) == 0 {
		return errors.New("服务端没有配置发布公钥（galaxy.bridge_release.public_keys），无法校验安装包签名")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil || len(raw) != ed25519.SignatureSize {
		return errors.New("签名不是合法的 base64 Ed25519 签名（用 scripts/release-sign.cjs sign 生成的 .sig 内容）")
	}
	message := bridgeSignedMessage(version, platform, digest)
	for _, key := range keys {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(key))
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			continue
		}
		if ed25519.Verify(ed25519.PublicKey(decoded), message, raw) {
			return nil
		}
	}
	return errors.New("签名校验不通过：这个包不是用平台的发布私钥签的，或者签完之后包被改过")
}

// PublishBridgeRelease 运营上传一个安装包：算校验值、验签、写 OSS、登记。
func (s *service) PublishBridgeRelease(ctx context.Context, req dto.PublishBridgeReleaseRequest) (dto.BridgeReleaseView, error) {
	if s.uploader == nil {
		return dto.BridgeReleaseView{}, errors.New("对象存储未配置，安装包上传不可用（oss.*）")
	}
	version, platform, err := ParseBridgePackageName(req.FileName)
	if err != nil {
		return dto.BridgeReleaseView{}, err
	}
	content, err := base64.StdEncoding.DecodeString(strings.TrimSpace(req.Content))
	if err != nil {
		return dto.BridgeReleaseView{}, errors.New("安装包内容不是合法的 base64")
	}
	if len(content) == 0 {
		return dto.BridgeReleaseView{}, errors.New("安装包是空的")
	}
	if len(content) > maxBridgePackageBytes {
		return dto.BridgeReleaseView{}, fmt.Errorf("安装包超过 %d MB", maxBridgePackageBytes>>20)
	}
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])
	// 签名里可能夹着换行（从 .sig 文件读出来的），去掉所有空白再验。
	signature := strings.Join(strings.Fields(req.Signature), "")
	if err := verifyBridgeSignature(s.config.BridgeReleaseKeys, version, platform, digest, signature); err != nil {
		return dto.BridgeReleaseView{}, err
	}

	now := time.Now()
	releaseID := "br_" + NewULID(now)
	existing, err := s.repository.FindBridgeReleaseTarget(ctx, bizLine, version, platform)
	switch {
	case err == nil && existing.Status == bridgePublished:
		// 覆盖一个在架的版本，等于让已经装了它的机器和将要装的机器拿到两份不同的字节，
		// 而版本号还是同一个。要重发就先下架，这一步是故意让人多想一下。
		return dto.BridgeReleaseView{}, fmt.Errorf("%s 的 %s 已经发布过了：先下架再重新上传", version, platform)
	case err == nil:
		releaseID = existing.ReleaseID
	case !notFound(err):
		return dto.BridgeReleaseView{}, err
	}

	objectKey := fmt.Sprintf("%s/%s/%s", bridgeObjectPrefix, version, req.FileName)
	storedKey, err := s.uploader.Put(ctx, objectKey, bridgeContentType(req.FileName), content, digest)
	if err != nil {
		return dto.BridgeReleaseView{}, fmt.Errorf("安装包写入对象存储失败：%w", err)
	}
	row := &repository.GalaxyBridgeRelease{
		BizLine: bizLine, ReleaseID: releaseID, Version: version, Platform: platform,
		FileName: strings.TrimSpace(req.FileName), ObjectKey: storedKey,
		Size: int64(len(content)), SHA256: digest, Signature: signature,
		Notes: truncate(strings.TrimSpace(req.Notes), 2000), Status: bridgePublished,
		PublishedBy: req.Operator, PublishedAt: &now,
	}
	if err := s.repository.SaveBridgeRelease(ctx, row); err != nil {
		return dto.BridgeReleaseView{}, err
	}
	return bridgeReleaseView(row), nil
}

// ListBridgeReleases 运营列表：全部，含已下架的，版本新的在前。
func (s *service) ListBridgeReleases(ctx context.Context) ([]dto.BridgeReleaseView, error) {
	rows, err := s.repository.ListBridgeReleases(ctx, bizLine, false)
	if err != nil {
		return nil, err
	}
	sortBridgeReleases(rows)
	views := make([]dto.BridgeReleaseView, 0, len(rows))
	for _, row := range rows {
		views = append(views, bridgeReleaseView(row))
	}
	return views, nil
}

// SetBridgeReleaseStatus 下架 / 重新上架。
//
// 下架之后：下载清单里没有它，新的升级请求不会挑到它，已经派下去、还没装完的
// 那一次会在下一个心跳被判失败（见 nodeupgrade.go）—— 一个被判有问题的版本
// 不该继续装到更多机器上。
func (s *service) SetBridgeReleaseStatus(ctx context.Context, req dto.SetBridgeReleaseStatusRequest) error {
	status := strings.TrimSpace(req.Status)
	if status != bridgePublished && status != bridgeWithdrawn {
		return fmt.Errorf("状态只能是 %s 或 %s", bridgePublished, bridgeWithdrawn)
	}
	var publishedAt *time.Time
	if status == bridgePublished {
		now := time.Now()
		publishedAt = &now
	}
	found, err := s.repository.SetBridgeReleaseStatus(ctx, bizLine, strings.TrimSpace(req.ReleaseID), status, publishedAt)
	if err != nil {
		return err
	}
	if !found {
		return errors.New("这个安装包不存在")
	}
	return nil
}

// BridgeManifest 下载清单：每个平台最新的那一版，外加安装脚本的地址。
func (s *service) BridgeManifest(ctx context.Context) (dto.BridgeReleaseManifest, error) {
	latest, err := s.latestBridgeReleases(ctx)
	if err != nil {
		return dto.BridgeReleaseManifest{}, err
	}
	hub := strings.TrimRight(strings.TrimSpace(s.config.ProviderHubURL), "/")
	manifest := dto.BridgeReleaseManifest{
		HubURL:    hub,
		Platforms: make([]dto.BridgeReleaseAsset, 0, len(latest)),
	}
	if hub != "" {
		manifest.InstallScript = hub + "/agent/v1/bridge/install.sh"
		manifest.InstallPowerShell = hub + "/agent/v1/bridge/install.ps1"
	}
	for _, platform := range bridgePlatforms {
		row, ok := latest[platform]
		if !ok {
			continue
		}
		asset := dto.BridgeReleaseAsset{
			Platform: row.Platform, Version: row.Version, FileName: row.FileName,
			Size: row.Size, SHA256: row.SHA256, Signature: row.Signature,
			DownloadURL: bridgeDownloadEndpoint(hub, row.Platform),
			Notes:       row.Notes, PublishedAt: row.PublishedAt,
		}
		manifest.Platforms = append(manifest.Platforms, asset)
		// 整体版本取各平台里最高的那一个：各平台的包通常同时发，
		// 偶尔有一片晚到，页面上那句「最新 0.2.0」该说的是已经能装到的最高版本。
		if manifest.Version == "" || compareBridgeVersions(row.Version, manifest.Version) > 0 {
			manifest.Version, manifest.Notes, manifest.PublishedAt = row.Version, row.Notes, row.PublishedAt
		}
	}
	return manifest, nil
}

// BridgeDownloadURL 解析出真正的对象地址，供 /agent/v1/bridge/download 那一跳 302 过去。
//
// version 为空表示这个平台的最新版。地址每次当场签发（默认一小时有效）：
// 稳定的是 Hub 上那个 302 地址，对象地址本来就不该被写进脚本。
func (s *service) BridgeDownloadURL(ctx context.Context, platform, version string) (string, error) {
	row, err := s.resolveBridgeRelease(ctx, platform, version)
	if err != nil {
		return "", err
	}
	if base := strings.TrimRight(strings.TrimSpace(s.config.BridgeDownloadBaseURL), "/"); base != "" {
		// 桶是公开读或者前面挂了 CDN 时走这条：省掉签名，地址也能被缓存。
		return base + "/" + strings.TrimLeft(row.ObjectKey, "/"), nil
	}
	if s.signer == nil {
		return "", errors.New("对象存储未配置，安装包下载不可用（oss.*）")
	}
	return s.signer.SignGet(ctx, row.ObjectKey, s.config.PresignGetTTL)
}

// BridgeChecksum 给安装脚本用的校验值，sha256sum 的格式。
func (s *service) BridgeChecksum(ctx context.Context, platform, version string) (string, string, error) {
	row, err := s.resolveBridgeRelease(ctx, platform, version)
	if err != nil {
		return "", "", err
	}
	return row.SHA256, row.FileName, nil
}

// resolveBridgeRelease 按平台（可选版本）取一行在架的发布记录。
func (s *service) resolveBridgeRelease(ctx context.Context, platform, version string) (*repository.GalaxyBridgeRelease, error) {
	platform = strings.TrimSpace(platform)
	if !knownBridgePlatform(platform) {
		return nil, fmt.Errorf("不认识的平台 %q", platform)
	}
	if version = strings.TrimSpace(version); version != "" {
		row, err := s.repository.FindBridgeReleaseTarget(ctx, bizLine, version, platform)
		if notFound(err) {
			return nil, fmt.Errorf("没有 %s 的 %s 安装包", version, platform)
		}
		if err != nil {
			return nil, err
		}
		if row.Status != bridgePublished {
			return nil, fmt.Errorf("%s 的 %s 安装包已下架", version, platform)
		}
		return row, nil
	}
	latest, err := s.latestBridgeReleases(ctx)
	if err != nil {
		return nil, err
	}
	row, ok := latest[platform]
	if !ok {
		return nil, fmt.Errorf("还没有适用于 %s 的安装包", platform)
	}
	return row, nil
}

// latestBridgeReleases 每个平台最新的那一版在架发布。
func (s *service) latestBridgeReleases(ctx context.Context) (map[string]*repository.GalaxyBridgeRelease, error) {
	rows, err := s.repository.ListBridgeReleases(ctx, bizLine, true)
	if err != nil {
		return nil, err
	}
	latest := map[string]*repository.GalaxyBridgeRelease{}
	for _, row := range rows {
		current, ok := latest[row.Platform]
		if !ok || compareBridgeVersions(row.Version, current.Version) > 0 {
			latest[row.Platform] = row
		}
	}
	return latest, nil
}

// sortBridgeReleases 版本新的在前，同版本按平台的固定顺序。
func sortBridgeReleases(rows []*repository.GalaxyBridgeRelease) {
	order := map[string]int{}
	for index, platform := range bridgePlatforms {
		order[platform] = index
	}
	sort.SliceStable(rows, func(left, right int) bool {
		if cmp := compareBridgeVersions(rows[left].Version, rows[right].Version); cmp != 0 {
			return cmp > 0
		}
		return order[rows[left].Platform] < order[rows[right].Platform]
	})
}

func bridgeDownloadEndpoint(hub, platform string) string {
	if hub == "" {
		return ""
	}
	return hub + "/agent/v1/bridge/download/" + url.PathEscape(platform)
}

func bridgeContentType(fileName string) string {
	if strings.HasSuffix(fileName, ".zip") {
		return "application/zip"
	}
	return "application/gzip"
}

func bridgeReleaseView(row *repository.GalaxyBridgeRelease) dto.BridgeReleaseView {
	return dto.BridgeReleaseView{
		ReleaseID: row.ReleaseID, Version: row.Version, Platform: row.Platform,
		FileName: row.FileName, Size: row.Size, SHA256: row.SHA256, Signature: row.Signature,
		Notes: row.Notes, Status: row.Status, PublishedBy: row.PublishedBy,
		PublishedAt: row.PublishedAt, CreatedAt: row.CreatedTime, UpdatedAt: row.UpdatedTime,
	}
}
