package account

import (
	"context"
	"errors"
	"testing"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

type stubIssuer struct {
	owners []string
	err    error
}

func (s *stubIssuer) IssueRegistrationKey(_ context.Context, ownerUserID string) (dto.IssuedKeyView, error) {
	s.owners = append(s.owners, ownerUserID)
	if s.err != nil {
		return dto.IssuedKeyView{}, s.err
	}
	return dto.IssuedKeyView{KeyID: "ck_1", Secret: "sk-galaxy-x", Alias: "默认密钥"}, nil
}

// TestRegistrationKeyOnlyForConsumer 共享端注册不该顺手签一把算力密钥。
//
// 那是使用端花钱调模型的凭证：签给一个出算力的人，他名下会凭空多出一把能扣钱的密钥，
// 而 Nova 的界面上根本没有地方显示它、也没有地方吊销它。
func TestRegistrationKeyOnlyForConsumer(t *testing.T) {
	issuer := &stubIssuer{}
	service := &service{keys: issuer}

	if view := service.issueRegistrationKey(context.Background(), &repository.GalaxyUser{
		UserID: "cu_1", Side: dto.SideConsumer,
	}); view == nil || view.Secret == "" {
		t.Fatal("使用端注册要带回一把密钥的明文")
	}
	if view := service.issueRegistrationKey(context.Background(), &repository.GalaxyUser{
		UserID: "pu_1", Side: dto.SideProvider,
	}); view != nil {
		t.Fatalf("共享端不该签算力密钥，却签出了 %s", view.KeyID)
	}
	if len(issuer.owners) != 1 || issuer.owners[0] != "cu_1" {
		t.Fatalf("签发方只该为使用端账号被调一次，实际是 %v", issuer.owners)
	}
}

// TestRegistrationKeyFailureKeepsAccount 密钥签不出来不能把注册一起拖垮。
//
// 账号那一刻已经建出来了。这里若把错误往上抛，用户看到「注册失败」再点一次，
// 迎面撞上的是「这个用户名已经被注册」—— 人就此卡在门外，而他其实已经有账号了。
// 没签出来只是密钥页空着，点一下「新建」就补上。
func TestRegistrationKeyFailureKeepsAccount(t *testing.T) {
	service := &service{keys: &stubIssuer{err: errors.New("数据库抖了一下")}}
	if view := service.issueRegistrationKey(context.Background(), &repository.GalaxyUser{
		UserID: "cu_2", Side: dto.SideConsumer,
	}); view != nil {
		t.Fatal("签发失败时不该回一把密钥")
	}
}

// TestRegistrationKeyWithoutIssuer 没注入签发方（manager-api 那一半）时不能炸。
func TestRegistrationKeyWithoutIssuer(t *testing.T) {
	service := &service{}
	if view := service.issueRegistrationKey(context.Background(), &repository.GalaxyUser{
		UserID: "cu_3", Side: dto.SideConsumer,
	}); view != nil {
		t.Fatal("没有签发方就不该有密钥")
	}
}
