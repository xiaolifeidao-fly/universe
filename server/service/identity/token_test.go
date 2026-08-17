package identity

import (
	"testing"
	"time"
)

func TestTokenRoundTrip(t *testing.T) {
	raw, err := issueToken("test-secret", 42, 3, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	claims, err := parseToken("test-secret", raw)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Subject != 42 || claims.TokenVersion != 3 {
		t.Fatalf("unexpected claims: %#v", claims)
	}
}

func TestTokenRejectsBadSignatureAndExpiry(t *testing.T) {
	raw, err := issueToken("test-secret", 42, 3, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseToken("other-secret", raw); err == nil {
		t.Fatal("token signed with another secret must be rejected")
	}
	expired, err := issueToken("test-secret", 42, 3, time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseToken("test-secret", expired); err == nil {
		t.Fatal("expired token must be rejected")
	}
}
