package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWidgetReferenceListsEveryFence(t *testing.T) {
	s := buildTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/kiwi/widgets/reference", nil)
	rec := httptest.NewRecorder()
	s.echo.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res widgetReferenceResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Fences) < 10 {
		t.Fatalf("expected the whole catalogue, got %d fences", len(res.Fences))
	}
	if len(res.ReservedTopLevel) == 0 || len(res.ReservedStep) == 0 {
		t.Error("expected the reserved key sets to be served alongside")
	}
	for _, f := range res.Fences {
		if f.Description == "" || f.Example == "" {
			t.Errorf("%s is missing its description or example", f.Lang)
		}
	}
}

func TestWidgetReferenceByName(t *testing.T) {
	s := buildTestServer(t)

	// An alias has to resolve, so the slash menu and the linter agree.
	for _, name := range []string{"array", "kiwi-array", "widget:array"} {
		req := httptest.NewRequest(http.MethodGet, "/api/kiwi/widgets/reference?name="+name, nil)
		rec := httptest.NewRecorder()
		s.echo.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: expected 200, got %d", name, rec.Code)
		}
		var res widgetReferenceResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
			t.Fatal(err)
		}
		if len(res.Fences) != 1 || res.Fences[0].Lang != "array" {
			t.Fatalf("%s: expected just the array fence, got %+v", name, res.Fences)
		}
		if _, ok := res.Fences[0].Attributes["values"]; !ok {
			t.Error("expected the array fence to document `values`")
		}
	}
}

func TestWidgetReferenceUnknownName(t *testing.T) {
	s := buildTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/kiwi/widgets/reference?name=nope", nil)
	rec := httptest.NewRecorder()
	s.echo.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}
