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

func TestConversationModeOfAcceptsOnlyKnownActions(t *testing.T) {
	// 老前端不带 mode，必须继续当普通发言处理。
	if mode, err := conversationModeOf(""); err != nil || mode != dto.ConversationModeStatement {
		t.Fatalf("unexpected default mode: %q %v", mode, err)
	}
	if mode, err := conversationModeOf(" document "); err != nil || mode != dto.ConversationModeDocument {
		t.Fatalf("unexpected document mode: %q %v", mode, err)
	}
	if _, err := conversationModeOf("delete"); err == nil {
		t.Fatal("expected unknown mode to be rejected")
	}
}

func TestSupplementOfKeepsOnlyRealInput(t *testing.T) {
	if supplement := supplementOf("   "); supplement != "" {
		t.Fatalf("blank supplement should be dropped: %q", supplement)
	}
	if supplement := supplementOf("只覆盖华东"); supplement != "\n\n补充说明：\n只覆盖华东" {
		t.Fatalf("unexpected supplement: %q", supplement)
	}
}

func TestContainsUserMessageIgnoresBlankAndAssistantRows(t *testing.T) {
	rows := []*repository.BusinessRequirementMessage{
		{Role: "assistant", Content: "请问你的目标是什么？"},
		{Role: "user", Content: "   "},
	}
	if containsUserMessage(rows) {
		t.Fatal("blank user rows must not count as something to document")
	}
	if !containsUserMessage(append(rows, &repository.BusinessRequirementMessage{Role: "user", Content: "想做直播"})) {
		t.Fatal("expected a real business statement to count")
	}
}
