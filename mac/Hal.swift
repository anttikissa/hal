// Hal.app (task bap): a native Mac window on Hal's web client. It holds
// no Hal code: it runs `hal serve` from the checkout that built it (or
// joins the host already running), takes the Open: link that `hal auth`
// prints (the host's web address with a one-time code) and shows it.

import Cocoa
import WebKit

let info = Bundle.main.infoDictionary ?? [:]
let checkout = info["HalCheckout"] as? String ?? "\(NSHomeDirectory())/.hal"
let bun = info["HalBun"] as? String ?? "\(NSHomeDirectory())/.bun/bin/bun"
let startWait: TimeInterval = 30

// `open -a Hal --args --home <dir>`; Finder adds arguments of its own.
func homeArgs() -> [String] {
	let a = CommandLine.arguments
	if let i = a.firstIndex(of: "--home"), i + 1 < a.count { return ["--home", a[i + 1]] }
	return []
}

// A GUI app gets launchd's bare environment; the agent's tools need the
// user's PATH and variables, as in a terminal. Read once from the login
// shell, like other editors do; on failure the app's own environment.
func shellEnvironment() -> [String: String] {
	var env = ProcessInfo.processInfo.environment
	let p = Process()
	p.executableURL = URL(fileURLWithPath: env["SHELL"] ?? "/bin/zsh")
	p.arguments = ["-ilc", "/usr/bin/env -0"]
	p.standardInput = FileHandle.nullDevice
	p.standardError = FileHandle.nullDevice
	let out = Pipe()
	p.standardOutput = out
	guard (try? p.run()) != nil else { return env }
	let killer = DispatchWorkItem { p.terminate() }
	DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: killer)
	let data = out.fileHandleForReading.readDataToEndOfFile()
	p.waitUntilExit()
	killer.cancel()
	guard p.terminationStatus == 0 else { return env }
	for entry in data.split(separator: 0) {
		guard let s = String(data: Data(entry), encoding: .utf8), let eq = s.firstIndex(of: "=") else { continue }
		env[String(s[..<eq])] = String(s[s.index(after: eq)...])
	}
	return env
}

// The last bytes a child printed, for an error page.
final class Tail {
	private var data = Data()
	private let lock = NSLock()
	func attach(_ p: Process) {
		let pipe = Pipe()
		p.standardOutput = pipe
		p.standardError = pipe
		pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
			let chunk = h.availableData
			if chunk.isEmpty { h.readabilityHandler = nil; return }
			self?.append(chunk)
		}
	}
	func append(_ chunk: Data) {
		lock.lock(); defer { lock.unlock() }
		data.append(chunk)
		if data.count > 16_384 { data = data.suffix(16_384) }
	}
	var text: String {
		lock.lock(); defer { lock.unlock() }
		return String(decoding: data, as: UTF8.self)
	}
}

func escape(_ s: String) -> String {
	s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
}

func page(_ body: String) -> String {
	"<html><body style='background:#141a26;color:#c8d0e0;font:13px ui-monospace,monospace;padding:2em'>\(body)</body></html>"
}

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
	var window: NSWindow!
	var web: WKWebView!
	var popups: [NSWindow] = []
	var env: [String: String] = [:]
	var serve: Process?
	let serveOutput = Tail()
	var quitting = false
	var origin = ""

	func applicationDidFinishLaunching(_ note: Notification) {
		NSApp.mainMenu = menu()
		web = webView(WKWebViewConfiguration())
		window = frame(web, autosave: "Hal")
		web.loadHTMLString(page("Hal is starting…"), baseURL: nil)
		NSApp.activate(ignoringOtherApps: true)
		DispatchQueue.global().async {
			self.env = shellEnvironment()
			DispatchQueue.main.sync { self.startServe() }
			self.join()
		}
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

	// Only the app's own hal serve stops; a host it joined keeps running.
	func applicationWillTerminate(_ note: Notification) {
		quitting = true
		guard let p = serve, p.isRunning else { return }
		let done = DispatchSemaphore(value: 0)
		p.terminationHandler = { _ in done.signal() }
		p.terminate()
		_ = done.wait(timeout: .now() + 5)
	}

	func hal(_ args: [String]) -> Process {
		let p = Process()
		p.executableURL = URL(fileURLWithPath: bun)
		p.arguments = ["\(checkout)/src/main.ts"] + args + homeArgs()
		p.environment = env
		p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
		p.standardInput = FileHandle.nullDevice
		return p
	}

	// Exit 100 is /restart host: start again, like ./run. Exit 1 when
	// another hal serve hosts; join() then finds that host.
	// ANTHROPIC_BASE_URL in the app's environment (benchmarks set it with
	// launchctl setenv to point at a replay server) becomes the flag.
	func startServe() {
		let url = env["ANTHROPIC_BASE_URL"].flatMap { $0.isEmpty ? nil : ["--anthropic-url", $0] } ?? []
		let p = hal(["serve"] + url)
		serveOutput.attach(p)
		p.terminationHandler = { p in
			DispatchQueue.main.async {
				if !self.quitting && p.terminationStatus == 100 { self.startServe() }
			}
		}
		do {
			try p.run()
			serve = p
		} catch {
			serveOutput.append(Data("cannot start \(bun): \(error)\n".utf8))
		}
	}

	// Asks the running host for its address and a code until it answers.
	// While its own hal serve runs, first waits until its web server is
	// up (its log says so): a terminal handing over may still answer. A
	// handover waits, without a time limit, for calls unsafe to stop.
	func join() {
		let started = Date()
		var deadline = started.addingTimeInterval(startWait)
		var waiting = false
		var last = ""
		while Date() < deadline {
			let log = serveOutput.text
			if serve?.isRunning == true && !log.contains(" web on ") && !log.contains(" web: ") {
				if log.contains("asked the host to hand over") {
					deadline = Date().addingTimeInterval(startWait)
					if !waiting && Date().timeIntervalSince(started) > 0.5 {
						waiting = true
						DispatchQueue.main.async {
							self.web.loadHTMLString(page("Waiting for the running hal to finish its long-running job…"), baseURL: nil)
						}
					}
				}
				Thread.sleep(forTimeInterval: 0.02)
				continue
			}
			let p = hal(["auth"])
			let out = Pipe(), err = Pipe()
			p.standardOutput = out
			p.standardError = err
			if (try? p.run()) != nil {
				let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
				last = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
				p.waitUntilExit()
				let lines = text.split(separator: "\n")
				let open = (lines.first { $0.hasPrefix("Local: ") } ?? lines.first { $0.hasPrefix("Open: ") })?.split(separator: " ", maxSplits: 1).last
				if p.terminationStatus == 0, let open, let u = URL(string: String(open)) {
					DispatchQueue.main.async {
						self.origin = "\(u.scheme ?? "http")://\(u.host ?? ""):\(u.port ?? (u.scheme == "https" ? 443 : 80))"
						self.web.load(URLRequest(url: u))
					}
					return
				}
			} else {
				last = "cannot run \(bun)\n"
			}
			Thread.sleep(forTimeInterval: 0.1)
		}
		let text = "Hal did not start within \(Int(startWait)) s.\n\nhal auth:\n\(last)\nhal serve:\n\(serveOutput.text)"
		DispatchQueue.main.async { self.web.loadHTMLString(page("<pre>\(escape(text))</pre>"), baseURL: nil) }
	}

	func ownPage(_ url: URL?) -> Bool {
		guard let u = url else { return false }
		return !origin.isEmpty && "\(u.scheme ?? "")://\(u.host ?? ""):\(u.port ?? (u.scheme == "https" ? 443 : 80))" == origin
	}

	func webView(_ config: WKWebViewConfiguration) -> WKWebView {
		let w = WKWebView(frame: .zero, configuration: config)
		w.navigationDelegate = self
		w.uiDelegate = self
		w.isInspectable = true
		w.underPageBackgroundColor = NSColor(red: 0.08, green: 0.10, blue: 0.15, alpha: 1)
		return w
	}

	func frame(_ view: NSView, autosave: String?) -> NSWindow {
		let w = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800),
			styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
		w.title = "Hal"
		w.contentView = view
		w.isReleasedWhenClosed = false
		w.center()
		if let name = autosave { w.setFrameAutosaveName(name) }
		w.makeKeyAndOrderFront(nil)
		return w
	}

	// Links elsewhere open in the default browser; Hal's own pages
	// (attachments, files) in another window that shares the login.
	func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
	             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
		let url = action.request.url
		if action.navigationType == .linkActivated, !ownPage(url), let u = url {
			NSWorkspace.shared.open(u)
			return decisionHandler(.cancel)
		}
		decisionHandler(.allow)
	}

	func webView(_ w: WKWebView, createWebViewWith config: WKWebViewConfiguration,
	             for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
		guard ownPage(action.request.url) else {
			if let u = action.request.url { NSWorkspace.shared.open(u) }
			return nil
		}
		let child = webView(config)
		popups.append(frame(child, autosave: nil))
		return child
	}

	func webViewDidClose(_ w: WKWebView) {
		w.window?.close()
		popups.removeAll { $0.contentView === w }
	}

	func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
	             initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
		let a = NSAlert()
		a.messageText = message
		a.runModal()
		completionHandler()
	}

	func webView(_ w: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
	             initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
		let panel = NSOpenPanel()
		panel.allowsMultipleSelection = parameters.allowsMultipleSelection
		panel.canChooseDirectories = parameters.allowsDirectories
		completionHandler(panel.runModal() == .OK ? panel.urls : nil)
	}

	func menu() -> NSMenu {
		let bar = NSMenu()
		func sub(_ title: String, _ items: [(String, Selector?, String)]) {
			let m = NSMenu(title: title)
			for (name, action, key) in items {
				if name == "-" { m.addItem(.separator()); continue }
				m.addItem(withTitle: name, action: action, keyEquivalent: key)
			}
			let item = NSMenuItem()
			item.submenu = m
			bar.addItem(item)
		}
		sub("Hal", [
			("Hide Hal", #selector(NSApplication.hide(_:)), "h"),
			("-", nil, ""),
			("Quit Hal", #selector(NSApplication.terminate(_:)), "q"),
		])
		sub("Edit", [
			("Undo", Selector(("undo:")), "z"),
			("Redo", Selector(("redo:")), "Z"),
			("-", nil, ""),
			("Cut", #selector(NSText.cut(_:)), "x"),
			("Copy", #selector(NSText.copy(_:)), "c"),
			("Paste", #selector(NSText.paste(_:)), "v"),
			("Select All", #selector(NSText.selectAll(_:)), "a"),
		])
		sub("Window", [
			("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
			("Close", #selector(NSWindow.performClose(_:)), "w"),
		])
		return bar
	}
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
