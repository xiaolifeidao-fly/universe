package relay

import "encoding/json"

func jsonUnmarshal(raw []byte, target any) error { return json.Unmarshal(raw, target) }
