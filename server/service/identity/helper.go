// identity 域内共用的小工具：枚举校验与错误翻译。

package identity

import (
	"errors"
	"strings"
	"time"

	"contract"
	"service/identity/internal/repository"
)

func validRole(value string) bool { return value == RoleAdmin || value == RoleMember }
func validPersona(value string) bool {
	return value == PersonaBusiness || value == PersonaProductResearch
}
func validStatus(value string) bool { return value == StatusActive || value == StatusDisabled }

// normalizePersonas accepts both the new array payload and the legacy single
// persona field. It returns a stable representation for persistence and API
// responses so the same identity set never produces different DB values.
func normalizePersonas(values []string, legacy string) ([]string, error) {
	if len(values) == 0 && strings.TrimSpace(legacy) != "" {
		values = strings.Split(legacy, ",")
	}
	selected := make(map[string]bool, len(values))
	for _, value := range values {
		persona := strings.TrimSpace(value)
		if !validPersona(persona) {
			return nil, errors.New("用户身份无效")
		}
		selected[persona] = true
	}
	if len(selected) == 0 {
		return nil, errors.New("请至少选择一个工作身份")
	}
	personas := make([]string, 0, len(selected))
	for _, persona := range []string{PersonaProductResearch, PersonaBusiness} {
		if selected[persona] {
			personas = append(personas, persona)
		}
	}
	return personas, nil
}

func personasOf(value string) []string {
	personas, err := normalizePersonas(strings.Split(value, ","), "")
	if err != nil {
		// Existing rows created before this feature always defaulted to product
		// research. Treat malformed legacy data the same way instead of denying
		// access to a user solely because an old column value was empty.
		return []string{PersonaProductResearch}
	}
	return personas
}

func personaStorage(personas []string) string { return strings.Join(personas, ",") }

func hasPersona(personas []string, target string) bool {
	for _, persona := range personas {
		if persona == target {
			return true
		}
	}
	return false
}

func translate(err error) error {
	if repository.IsNotFound(err) {
		return contract.ErrNotFound
	}
	return err
}

func timePtr(value time.Time) *time.Time { return &value }
