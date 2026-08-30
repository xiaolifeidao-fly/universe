package identity

import (
	"reflect"
	"testing"
)

func TestNormalizePersonasStoresStableMultiIdentitySet(t *testing.T) {
	personas, err := normalizePersonas([]string{PersonaBusiness, PersonaProductResearch, PersonaBusiness}, "")
	if err != nil {
		t.Fatalf("normalizePersonas returned error: %v", err)
	}
	want := []string{PersonaProductResearch, PersonaBusiness}
	if !reflect.DeepEqual(personas, want) {
		t.Fatalf("personas = %#v, want %#v", personas, want)
	}
	if got := personaStorage(personas); got != "product_research,business" {
		t.Fatalf("storage = %q", got)
	}
}

func TestNormalizePersonasAcceptsLegacySingleIdentity(t *testing.T) {
	personas, err := normalizePersonas(nil, PersonaBusiness)
	if err != nil {
		t.Fatalf("normalizePersonas returned error: %v", err)
	}
	if !reflect.DeepEqual(personas, []string{PersonaBusiness}) {
		t.Fatalf("personas = %#v", personas)
	}
}
