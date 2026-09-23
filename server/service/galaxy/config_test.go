package galaxy

import "testing"

// 对外地址派生。这两个值是**直接显示给用户、让他照着填**的，算错了不会报错，
// 只会让人把节点或 SDK 指到一个够不到的地方 —— 而那种故障在界面上什么都看不见
// （节点连错 Hub 就不出现在任何列表里），所以这里逐种部署形态钉一遍。
func TestPublicURLDerivation(t *testing.T) {
	cases := []struct {
		name             string
		instance         string
		consumerBaseURL  string
		providerHubURL   string
		wantConsumerBase string
		wantProviderHub  string
	}{
		{
			name:             "单机开发：两个都从 instance 派生",
			instance:         "http://127.0.0.1:10004",
			wantConsumerBase: "http://127.0.0.1:10004/v1",
			wantProviderHub:  "http://127.0.0.1:10004",
		},
		{
			// 生产部署只配了 consumer_base_url 时，节点地址必须跟着它走而不是跟着
			// instance —— 后者是内网地址，用户根本够不到。
			name:             "配了对外入口：节点地址跟着它走，不回落 instance",
			instance:         "http://10.0.0.7:10004",
			consumerBaseURL:  "https://hub.example.com/v1",
			wantConsumerBase: "https://hub.example.com/v1",
			wantProviderHub:  "https://hub.example.com",
		},
		{
			name:             "带端口的自建部署",
			instance:         "http://127.0.0.1:10004",
			consumerBaseURL:  "https://47.110.3.214:10005/v1",
			wantConsumerBase: "https://47.110.3.214:10005/v1",
			wantProviderHub:  "https://47.110.3.214:10005",
		},
		{
			// 尾斜杠是配置文件里最容易多出来的一个字符，不能因此多派生出一个空段。
			name:             "对外入口带尾斜杠",
			instance:         "http://127.0.0.1:10004",
			consumerBaseURL:  "https://hub.example.com/v1/",
			wantConsumerBase: "https://hub.example.com/v1/",
			wantProviderHub:  "https://hub.example.com",
		},
		{
			name:             "两个都显式配：一个字都不改",
			instance:         "http://10.0.0.7:10004",
			consumerBaseURL:  "https://api.example.com/v1",
			providerHubURL:   "https://nodes.example.com",
			wantConsumerBase: "https://api.example.com/v1",
			wantProviderHub:  "https://nodes.example.com",
		},
		{
			// 挂在子路径下的部署，/v1 之前那一段必须原样留着。
			name:             "反代到子路径",
			instance:         "http://127.0.0.1:10004",
			consumerBaseURL:  "https://example.com/galaxy/v1",
			wantConsumerBase: "https://example.com/galaxy/v1",
			wantProviderHub:  "https://example.com/galaxy",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			config := Config{
				Instance:        testCase.instance,
				ConsumerBaseURL: testCase.consumerBaseURL,
				ProviderHubURL:  testCase.providerHubURL,
			}.withDefaults()
			if config.ConsumerBaseURL != testCase.wantConsumerBase {
				t.Errorf("ConsumerBaseURL = %q，期望 %q", config.ConsumerBaseURL, testCase.wantConsumerBase)
			}
			if config.ProviderHubURL != testCase.wantProviderHub {
				t.Errorf("ProviderHubURL = %q，期望 %q", config.ProviderHubURL, testCase.wantProviderHub)
			}
		})
	}
}

// 一个字段都没配时不该凭空造出地址：宁可空着让控制台整块不显示，
// 也不能显示一个猜的。
func TestPublicURLEmptyWhenUnset(t *testing.T) {
	config := Config{}.withDefaults()
	if config.ConsumerBaseURL != "" {
		t.Errorf("ConsumerBaseURL 应为空，实际 %q", config.ConsumerBaseURL)
	}
	if config.ProviderHubURL != "" {
		t.Errorf("ProviderHubURL 应为空，实际 %q", config.ProviderHubURL)
	}
}
