package business

import (
	"testing"

	"service/business/dto"
	"service/business/internal/repository"
)

func TestBusinessWorkspaceUsesUserAndProjectName(t *testing.T) {
	workspace, err := businessWorkspace("alice", dto.ProgramContext{Name: "客户运营平台"})
	if err != nil {
		t.Fatalf("businessWorkspace returned error: %v", err)
	}
	if workspace != "alice/业务空间/客户运营平台" {
		t.Fatalf("unexpected workspace: %q", workspace)
	}
}

func TestBusinessWorkspaceRejectsPathSeparators(t *testing.T) {
	_, err := businessWorkspace("alice", dto.ProgramContext{Name: "客户/运营平台"})
	if err == nil {
		t.Fatal("expected invalid project directory error")
	}
}

func TestAttachmentViewsBelongToTheirOwnMessage(t *testing.T) {
	rows := []*repository.BusinessRequirementAttachment{
		{RemoteID: "a", Name: "背景.png", MessageID: 7, IsImage: true, Size: 12},
		{RemoteID: "b", Name: "口径.md", MessageID: 8},
		{RemoteID: "c", Name: "还没发出的.png", MessageID: 0, IsImage: true},
	}
	views := attachmentViewsFor(rows, 7)
	if len(views) != 1 || views[0].ID != "a" || views[0].Name != "背景.png" || !views[0].IsImage {
		t.Fatalf("unexpected views for message 7: %#v", views)
	}
	// 未绑定的上传不属于任何一条消息，否则草稿里的文件会跟着历史一起展示。
	if views := attachmentViewsFor(rows, 0); len(views) != 1 || views[0].ID != "c" {
		t.Fatalf("unexpected unsent views: %#v", views)
	}
	if views := attachmentViewsFor(rows, 9); views != nil {
		t.Fatalf("expected no views for an unrelated message: %#v", views)
	}
}

func TestTrimmedIDsDropsBlanks(t *testing.T) {
	if ids := trimmedIDs([]string{" a ", "", "   ", "b"}); len(ids) != 2 || ids[0] != "a" || ids[1] != "b" {
		t.Fatalf("unexpected ids: %#v", ids)
	}
}
