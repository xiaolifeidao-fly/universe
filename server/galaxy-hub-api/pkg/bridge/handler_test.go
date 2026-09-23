package bridge_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"galaxy-hub-api/pkg/bridge"
	"service/galaxy"
	"service/galaxy/dto"
)

// 分发面的调用方是 curl、shell 脚本和节点自己：它们只看状态码、重定向和纯文本。
// 所以这里钉的是**形状**——占位符换没换、302 去哪、校验值是不是 sha256sum 的格式。

type fakeGalaxy struct {
	// 只实现这个包会用到的几个方法。没实现的被调到会 panic —— 那条路本来就不该走到。
	galaxy.Service

	hub      string
	manifest dto.BridgeReleaseManifest
	url      string
	err      error
}

func (f *fakeGalaxy) Config() galaxy.Config {
	config := galaxy.DefaultConfig()
	config.ProviderHubURL = f.hub
	return config
}

func (f *fakeGalaxy) BridgeManifest(context.Context) (dto.BridgeReleaseManifest, error) {
	return f.manifest, f.err
}

func (f *fakeGalaxy) BridgeDownloadURL(context.Context, string, string) (string, error) {
	return f.url, f.err
}

func (f *fakeGalaxy) BridgeChecksum(context.Context, string, string) (string, string, error) {
	if f.err != nil {
		return "", "", f.err
	}
	return "29497afb", "ai-bridge-0.2.0-linux-x64.tar.gz", nil
}

func serve(service galaxy.Service) *gin.Engine {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	bridge.NewHandler(service).RegisterHandler(engine.Group("/agent/v1"))
	return engine
}

func get(engine *gin.Engine, path string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder
}

// 脚本是边下边执行的，里面的平台地址必须是真地址。
func TestInstallScriptsCarryTheRealHubAddress(t *testing.T) {
	engine := serve(&fakeGalaxy{hub: "https://hub.example.com"})
	for _, path := range []string{"/agent/v1/bridge/install.sh", "/agent/v1/bridge/install.ps1"} {
		response := get(engine, path)
		if response.Code != http.StatusOK {
			t.Fatalf("%s 应当返回 200，得到 %d", path, response.Code)
		}
		body := response.Body.String()
		if strings.Contains(body, "__HUB_URL__") {
			t.Errorf("%s 里的占位符没换掉：脚本会去连一个叫 __HUB_URL__ 的主机", path)
		}
		if !strings.Contains(body, "https://hub.example.com") {
			t.Errorf("%s 里没有平台地址", path)
		}
	}
}

// 没配对外地址时宁可 503：发一个带占位符的脚本出去，用户看到的报错和
// 「平台没配好」一点关系都看不出来。
func TestInstallScriptRefusesWhenTheHubAddressIsMissing(t *testing.T) {
	response := get(serve(&fakeGalaxy{}), "/agent/v1/bridge/install.sh")
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("没配平台地址时应当 503，得到 %d", response.Code)
	}
	if !strings.Contains(response.Body.String(), "provider_hub_url") {
		t.Error("要说清楚是哪一项配置没配")
	}
}

func TestDownloadRedirectsToTheObjectStore(t *testing.T) {
	signed := "https://bucket.example.com/galaxy/ai-bridge/0.2.0/ai-bridge-0.2.0-linux-x64.tar.gz?Signature=x"
	engine := serve(&fakeGalaxy{hub: "https://hub.example.com", url: signed})
	response := get(engine, "/agent/v1/bridge/download/linux-x64")
	// 302 而不是 301：签名地址每次都不一样，被缓存成永久重定向就麻烦了。
	if response.Code != http.StatusFound {
		t.Fatalf("应当 302，得到 %d", response.Code)
	}
	if location := response.Header().Get("Location"); location != signed {
		t.Fatalf("跳错地方了：%s", location)
	}
}

// 没有包时要回 404 + 机器读得懂的 code：安装脚本靠状态码分支，
// 而节点在升级时靠 code 区分「这个版本没了」和「服务端出错了」。
func TestDownloadReportsMissingPackagesAsNotFound(t *testing.T) {
	engine := serve(&fakeGalaxy{hub: "https://hub.example.com", err: errors.New("还没有适用于 linux-x64 的安装包")})
	response := get(engine, "/agent/v1/bridge/download/linux-x64")
	if response.Code != http.StatusNotFound {
		t.Fatalf("应当 404，得到 %d", response.Code)
	}
	var failure map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil {
		t.Fatalf("错误体应当是 JSON：%v", err)
	}
	if failure["code"] != "release_not_found" {
		t.Fatalf("错误码不对：%v", failure["code"])
	}
}

// 校验值直接喂给 sha256sum -c：两个空格的分隔是那个格式的一部分。
func TestChecksumUsesTheSha256sumFormat(t *testing.T) {
	engine := serve(&fakeGalaxy{hub: "https://hub.example.com"})
	response := get(engine, "/agent/v1/bridge/checksum/linux-x64")
	if response.Code != http.StatusOK {
		t.Fatalf("应当 200，得到 %d", response.Code)
	}
	want := "29497afb  ai-bridge-0.2.0-linux-x64.tar.gz\n"
	if response.Body.String() != want {
		t.Fatalf("格式不对：%q，想要 %q", response.Body.String(), want)
	}
}

// 清单是裸 JSON，不套统一信封：调用方是 curl 和节点，多一层壳只会让它们多解析一次。
func TestManifestIsPlainJSON(t *testing.T) {
	manifest := dto.BridgeReleaseManifest{
		Version:   "0.2.0",
		HubURL:    "https://hub.example.com",
		Platforms: []dto.BridgeReleaseAsset{{Platform: "linux-x64", Version: "0.2.0", SHA256: "29497afb"}},
	}
	engine := serve(&fakeGalaxy{hub: "https://hub.example.com", manifest: manifest})
	response := get(engine, "/agent/v1/bridge/releases/latest")
	if response.Code != http.StatusOK {
		t.Fatalf("应当 200，得到 %d", response.Code)
	}

	var envelope map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("响应应当是 JSON：%v", err)
	}
	if _, wrapped := envelope["data"]; wrapped {
		t.Error("这条路不套 success/data 信封")
	}

	var decoded dto.BridgeReleaseManifest
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("清单解析失败：%v", err)
	}
	if decoded.Version != "0.2.0" || len(decoded.Platforms) != 1 || decoded.Platforms[0].SHA256 != "29497afb" {
		t.Fatalf("清单内容对不上：%+v", decoded)
	}
}
