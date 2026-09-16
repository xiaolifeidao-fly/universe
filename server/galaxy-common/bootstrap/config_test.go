package bootstrap

import (
	"os"
	"strings"
	"testing"
)

// InstanceAddress 是多实例部署里唯一逐台不同的值，注入途径错一条就会让
// 节点把上行送到别的实例 —— 那种故障是概率性的、日志两边都正常，所以这里逐条钉住。
func TestInstanceAddress(t *testing.T) {
	host, err := os.Hostname()
	if err != nil {
		t.Skipf("取不到主机名：%v", err)
	}
	short := strings.SplitN(host, ".", 2)[0]

	for _, testCase := range []struct {
		name string
		env  string
		want string
	}{
		{name: "没配时回落到本机默认", env: "", want: "http://127.0.0.1:10006"},
		{name: "环境变量原样生效", env: "https://hub-2.example.com", want: "https://hub-2.example.com"},
		{name: "两边留白视同没配", env: "   ", want: "http://127.0.0.1:10006"},
		{name: "占位符换成主机名短名", env: "https://hub.example.com/s/{hostname}", want: "https://hub.example.com/s/" + short},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			t.Setenv("GALAXY_INSTANCE", testCase.env)
			if got := InstanceAddress(); got != testCase.want {
				t.Fatalf("InstanceAddress() = %q，期望 %q", got, testCase.want)
			}
		})
	}
}
