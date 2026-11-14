// Zero Notes CLI and Chrome Native Messaging host for macOS and Linux.
//go:build darwin || linux

package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"syscall"
	"time"
)

const hostName = "com.madsolame.zero_notes"
const installUsage = "usage: zero-notes install [--browser chrome|arc] [--user-data-dir <path>] <extension-id>"
const maxMessage = 16 << 20
const timeout = 10 * time.Second

var extensionID = regexp.MustCompile(`^[a-p]{32}$`)
var extensionOrigin = regexp.MustCompile(`^chrome-extension://[a-p]{32}/?$`)

type request struct {
	Site string `json:"site"`
}

type response struct {
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "zero-notes:", err)
		os.Exit(1)
	}
}

func run(args []string, output io.Writer) error {
	if len(args) == 1 && extensionOrigin.MatchString(args[0]) {
		return serve(os.Stdin, output)
	}
	if len(args) == 0 {
		return errors.New(installUsage + "\n       zero-notes list --site <url> [--json]")
	}
	switch args[0] {
	case "install":
		flags := flag.NewFlagSet("install", flag.ContinueOnError)
		browser := flags.String("browser", "chrome", "browser to register with (chrome or arc)")
		userData := flags.String("user-data-dir", "", "override the browser's user data directory")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 1 || !extensionID.MatchString(flags.Arg(0)) {
			return errors.New(installUsage)
		}
		return install(*browser, *userData, flags.Arg(0), output)
	case "list":
		flags := flag.NewFlagSet("list", flag.ContinueOnError)
		site := flags.String("site", "", "site URL")
		flags.Bool("json", false, "print JSON (default)")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *site == "" || len(*site) > 4096 || flags.NArg() != 0 {
			return errors.New("usage: zero-notes list --site <url> [--json]")
		}
		return list(*site, output)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func install(browser, userData, id string, output io.Writer) error {
	if browser != "chrome" && browser != "arc" {
		return fmt.Errorf("unsupported browser %q", browser)
	}
	if browser == "arc" && runtime.GOOS != "darwin" {
		return errors.New("Arc installation is available on macOS")
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	if userData == "" {
		switch {
		case browser == "arc":
			userData = filepath.Join(config, "Arc", "User Data")
		case runtime.GOOS == "darwin":
			userData = filepath.Join(config, "Google", "Chrome")
		default:
			userData = filepath.Join(config, "google-chrome")
		}
	}
	userData, err = filepath.Abs(userData)
	if err != nil {
		return err
	}
	info, err := os.Stat(userData)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("browser user data directory %q is missing. Open the browser first or pass --user-data-dir", userData)
		}
		return fmt.Errorf("check browser user data directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("browser user data path %q is not a directory", userData)
	}

	executable, err := os.Executable()
	if err != nil {
		return err
	}
	binaryPath := filepath.Join(config, "zero-notes", "bin", "zero-notes")
	binary, err := os.Open(executable)
	if err != nil {
		return err
	}
	defer binary.Close()
	if err := saveFile(binaryPath, 0700, func(file io.Writer) error {
		_, err := io.Copy(file, binary)
		return err
	}); err != nil {
		return fmt.Errorf("install helper: %w", err)
	}

	manifestPath := filepath.Join(userData, "NativeMessagingHosts", hostName+".json")
	manifest := struct {
		Name           string   `json:"name"`
		Description    string   `json:"description"`
		Path           string   `json:"path"`
		Type           string   `json:"type"`
		AllowedOrigins []string `json:"allowed_origins"`
	}{hostName, "Read saved Zero Notes", binaryPath, "stdio", []string{"chrome-extension://" + id + "/"}}
	if err := saveFile(manifestPath, 0600, func(file io.Writer) error {
		return json.NewEncoder(file).Encode(manifest)
	}); err != nil {
		return fmt.Errorf("register native host: %w", err)
	}
	_, err = fmt.Fprintf(output, "Helper: %s\nRegistration: %s\nOpen Zero Notes in the same browser profile and click Connect CLI.\n", binaryPath, manifestPath)
	return err
}

func saveFile(path string, mode os.FileMode, write func(io.Writer) error) error {
	folder := filepath.Dir(path)
	if err := os.MkdirAll(folder, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(folder, ".zero-notes-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	writeErr := write(file)
	if writeErr == nil {
		writeErr = file.Chmod(mode)
	}
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func socketDir() string {
	return fmt.Sprintf("/tmp/zero-notes-%d", os.Getuid())
}

func checkSocketDir(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm() != 0700 || int(info.Sys().(*syscall.Stat_t).Uid) != os.Getuid() {
		return errors.New("unsafe Zero Notes socket directory")
	}
	return nil
}

func list(site string, output io.Writer) error {
	dir := socketDir()
	if err := checkSocketDir(dir); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("no browser connected; open Zero Notes and click Connect CLI")
		}
		return err
	}
	socket, err := net.DialTimeout("unix", filepath.Join(dir, "host.sock"), time.Second)
	if err != nil {
		return fmt.Errorf("no browser connected; open Zero Notes and click Connect CLI: %w", err)
	}
	defer socket.Close()
	if err := socket.SetDeadline(time.Now().Add(2 * timeout)); err != nil {
		return err
	}
	if err := json.NewEncoder(socket).Encode(request{Site: site}); err != nil {
		return err
	}
	var result response
	if err := json.NewDecoder(io.LimitReader(socket, maxMessage)).Decode(&result); err != nil {
		return fmt.Errorf("read from Chrome: %w", err)
	}
	if result.Error != "" {
		return errors.New(result.Error)
	}
	if len(result.Data) == 0 || string(result.Data) == "null" {
		return errors.New("Chrome returned no result")
	}
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(result.Data)
}

func serve(input io.Reader, output io.Writer) error {
	dir := socketDir()
	if err := os.Mkdir(dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	if err := checkSocketDir(dir); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "host.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = writeFrame(output, map[string]string{"error": "Zero Notes CLI is already connected in another Chrome profile."})
		return err
	}

	path := filepath.Join(dir, "host.sock")
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return err
	}
	defer listener.Close()
	if err := writeFrame(output, map[string]bool{"ready": true}); err != nil {
		return err
	}

	replies := make(chan response)
	done := make(chan struct{})
	defer close(done)
	go func() {
		defer listener.Close()
		defer close(replies)
		for {
			var reply response
			if err := readFrame(input, &reply); err != nil {
				return
			}
			select {
			case replies <- reply:
			case <-done:
				return
			}
		}
	}()

	for {
		socket, err := listener.AcceptUnix()
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		if err != nil {
			return err
		}
		err = handleRequest(socket, output, replies)
		socket.Close()
		if err != nil {
			return err
		}
	}
}

func handleRequest(socket net.Conn, output io.Writer, replies <-chan response) error {
	_ = socket.SetDeadline(time.Now().Add(timeout))
	var req request
	if err := json.NewDecoder(io.LimitReader(socket, 8192)).Decode(&req); err != nil || req.Site == "" || len(req.Site) > 4096 {
		_ = json.NewEncoder(socket).Encode(response{Error: "invalid site request"})
		return nil
	}
	if err := writeFrame(output, req); err != nil {
		return err
	}

	select {
	case reply, ok := <-replies:
		if !ok {
			return io.EOF
		}
		_ = socket.SetWriteDeadline(time.Now().Add(time.Second))
		_ = json.NewEncoder(socket).Encode(reply)
		return nil
	case <-time.After(timeout):
		_ = socket.SetWriteDeadline(time.Now().Add(time.Second))
		_ = json.NewEncoder(socket).Encode(response{Error: "Chrome timed out. Reconnect from the extension popup."})
		return errors.New("Chrome timed out")
	}
}

func readFrame(input io.Reader, value any) error {
	var header [4]byte
	if _, err := io.ReadFull(input, header[:]); err != nil {
		return err
	}
	size := binary.NativeEndian.Uint32(header[:])
	if size == 0 || size > maxMessage {
		return errors.New("invalid native message size")
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(input, payload); err != nil {
		return err
	}
	return json.Unmarshal(payload, value)
}

func writeFrame(output io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var header [4]byte
	binary.NativeEndian.PutUint32(header[:], uint32(len(payload)))
	_, err = output.Write(append(header[:], payload...))
	return err
}
