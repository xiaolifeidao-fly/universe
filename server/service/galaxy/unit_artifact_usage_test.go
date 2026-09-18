package galaxy

import (
	"testing"

	"contract"
	"galaxy-common/kinds"
)

// 产物大小声明成 Hub 权威，就得真的由 Hub 算出来。
//
// kinds 把 storage.bytes 放进 video.edit.render 的 Trusted 里（「看产物元数据」），
// 但 Hub 只在 relay 的字节对拷收尾处写过 hubUsage —— job 走 submitDetached，
// 一次都不调。不补这一步，每条渲染都掉进「回退节点自报」：声明的权威名不副实，
// 事件流里还多一条假的 usage_parse_failed。
func TestArtifactBytesAreCountedByTheHub(t *testing.T) {
	spec := kinds.VideoFarm([]string{"ffmpeg"}, 10, 100)
	outputs := []contract.Payload{
		{Name: "output.mp4", Ref: &contract.ArtifactRef{Key: "galaxy/a", Size: 700}},
		{Name: "preview.mp4", Ref: &contract.ArtifactRef{Key: "galaxy/b", Size: 300}},
	}

	usage := withArtifactBytes(nil, spec, outputs)
	if got := usage[contract.UnitStorageBytes]; got != 1000 {
		t.Fatalf("产物大小该由 Hub 自己加出来，实际 %d", got)
	}
}

// 取的是 Hub 签发过的产物引用，不是节点 usage 里那个自由填写的数：
// 节点可以报 storage.bytes=1 却传一个大文件上去。
func TestArtifactBytesOverrideWhatTheNodeClaims(t *testing.T) {
	spec := kinds.VideoFarm([]string{"ffmpeg"}, 10, 100)
	hubUsage := contract.Metering{contract.UnitStorageBytes: 1}
	outputs := []contract.Payload{{Name: "output.mp4", Ref: &contract.ArtifactRef{Key: "galaxy/a", Size: 9 << 30}}}

	usage := withArtifactBytes(hubUsage, spec, outputs)
	if got := usage[contract.UnitStorageBytes]; got != 9<<30 {
		t.Fatalf("要以产物引用为准，实际 %d", got)
	}
}

// 没有产物的终态不该凭空造出一个 0 —— 让它照常落进「这次没有这个量」。
// relay 也一样：它的 Trusted 里没有 storage.bytes，一个字节的产物都不会有。
func TestArtifactBytesLeftAloneWhenThereIsNothingToCount(t *testing.T) {
	video := kinds.VideoFarm([]string{"ffmpeg"}, 10, 100)
	if usage := withArtifactBytes(nil, video, nil); usage != nil {
		t.Fatalf("没有产物时不该建出用量：%v", usage)
	}

	relay := kinds.Relay(map[string]string{"anthropic": "claude_oauth", "openai": "codex_chatgpt"}, 1<<20)
	outputs := []contract.Payload{{Name: "x", Ref: &contract.ArtifactRef{Key: "galaxy/a", Size: 5}}}
	if usage := withArtifactBytes(nil, relay, outputs); usage != nil {
		t.Fatalf("relay 不按产物计量，不该被写进 storage.bytes：%v", usage)
	}
}

// 次数与时长由 Hub 在 reconcileUsage 末尾无条件重算，中途从节点自报里取到什么都会被盖掉。
// 给它们记「解析失败」只会让事件流堆满永远不用查的噪声。
func TestHubRecomputedUnitsLeaveNoParseFailureTrail(t *testing.T) {
	for _, unit := range []contract.MeterUnit{contract.UnitCalls, contract.UnitTimeSeconds} {
		if !hubRecomputes(unit) {
			t.Fatalf("%s 由 Hub 重算，不该留痕", unit)
		}
	}
	for _, unit := range []contract.MeterUnit{contract.UnitInputTokens, contract.UnitStorageBytes} {
		if hubRecomputes(unit) {
			t.Fatalf("%s 不是 Hub 重算的，回退时必须留痕待审", unit)
		}
	}
}
