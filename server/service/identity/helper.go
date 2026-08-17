// identity 域内共用的小工具：枚举校验与错误翻译。

package identity

import (
	"time"

	"contract"
	"service/identity/internal/repository"
)

func validRole(value string) bool   { return value == RoleAdmin || value == RoleMember }
func validStatus(value string) bool { return value == StatusActive || value == StatusDisabled }

func translate(err error) error {
	if repository.IsNotFound(err) {
		return contract.ErrNotFound
	}
	return err
}

func timePtr(value time.Time) *time.Time { return &value }
