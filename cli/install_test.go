//go:build darwin || linux

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestInstallRegistersOnlySelectedChromeDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	config, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	userData := filepath.Join(home, "browser-test")
	if err := os.Mkdir(userData, 0700); err != nil {
		t.Fatal(err)
	}
	const id = "abcdefghijklmnopabcdefghijklmnop"
	args := []string{"install", "--user-data-dir", userData, id}
	for range 2 {
		if err := run(args, os.Stdout); err != nil {
			t.Fatal(err)
		}
	}
	registration := filepath.Join(userData, "NativeMessagingHosts", hostName+".json")
	data, err := os.ReadFile(registration)
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Name           string   `json:"name"`
		Path           string   `json:"path"`
		Type           string   `json:"type"`
		AllowedOrigins []string `json:"allowed_origins"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	wantPath := filepath.Join(config, "zero-notes", "bin", "zero-notes")
	if manifest.Name != hostName || manifest.Type != "stdio" || manifest.Path != wantPath ||
		!slices.Equal(manifest.AllowedOrigins, []string{"chrome-extension://" + id + "/"}) {
		t.Fatalf("unexpected native host manifest: %+v", manifest)
	}
	for _, file := range []struct {
		path string
		mode os.FileMode
	}{{registration, 0600}, {wantPath, 0700}} {
		info, err := os.Stat(file.path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != file.mode {
			t.Errorf("%s permissions = %o, want %o", file.path, info.Mode().Perm(), file.mode)
		}
	}
	defaultChrome := filepath.Join(chromeUserDataDir(config), "NativeMessagingHosts")
	if _, err := os.Stat(defaultChrome); !os.IsNotExist(err) {
		t.Errorf("installer touched the default Chrome directory: %v", err)
	}
}
