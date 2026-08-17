// 交付域内跨子域共用的小工具：日期、操作人、取整与错误翻译。

package delivery

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"

	"contract"
)

func parseDate(value string) (*time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	parsed, err := time.ParseInLocation(dateLayout, value, time.Local)
	if err != nil {
		return nil, errors.New("日期格式应为 2006-01-02")
	}
	return &parsed, nil
}

func formatDate(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.Format(dateLayout)
}

func actorOf(actorID, actorName string) string {
	if actorName != "" {
		return actorName
	}
	return actorID
}

func round2(value float64) float64 {
	return float64(int64(value*100+0.5)) / 100
}

func translate(err error) error {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return contract.ErrNotFound
	}
	return err
}

// normalizeBenefitTags 让任务收益标签保持简短、去重且有稳定顺序。
// 每条新任务都必须有至少一个标签；存量任务的空值仅在读取时兼容。
func normalizeBenefitTags(values []string) ([]string, error) {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		tag := strings.TrimSpace(value)
		if tag == "" {
			continue
		}
		if utf8.RuneCountInString(tag) > maxBenefitTagRunes {
			return nil, errors.New("任务收益标签不能超过 32 字符")
		}
		if _, exists := seen[tag]; exists {
			continue
		}
		seen[tag] = struct{}{}
		result = append(result, tag)
	}
	if len(result) == 0 {
		return nil, errors.New("请至少填写一个任务收益标签")
	}
	if len(result) > maxBenefitTagCount {
		return nil, errors.New("任务收益标签最多 6 个")
	}
	return result, nil
}

func marshalBenefitTags(values []string) (string, []string, error) {
	tags, err := normalizeBenefitTags(values)
	if err != nil {
		return "", nil, err
	}
	raw, err := json.Marshal(tags)
	if err != nil {
		return "", nil, err
	}
	return string(raw), tags, nil
}

// storedBenefitTags 仅用于读历史记录：旧任务和异常历史值回显为空，不能让看板读取失败。
func storedBenefitTags(value string) []string {
	if strings.TrimSpace(value) == "" {
		return []string{}
	}
	var values []string
	if err := json.Unmarshal([]byte(value), &values); err != nil {
		return []string{}
	}
	tags, err := normalizeBenefitTags(values)
	if err != nil {
		return []string{}
	}
	return tags
}
