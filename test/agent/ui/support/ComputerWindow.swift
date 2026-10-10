import AppKit

/// 同时记录应用分发层，区分事件未送达与事件落在标题栏等非内容区域。
@objc(TestApplication)
final class TestApplication: NSApplication {
    var received: [[String: Any]] = []
    var keyboardEvents: [[String: Any]] = []
    var fixtureWindows: [NSWindow] = []
    // 自定义应用显式发布自有实际窗口；对象身份和控件树仍由 AppKit 提供。
    override func accessibilityWindows() -> [Any]? {
        fixtureWindows.filter { $0.isVisible }
    }
    override func sendEvent(_ event: NSEvent) {
        if [.keyDown, .keyUp].contains(event.type) {
            keyboardEvents.append(["type": event.type.rawValue, "window": event.windowNumber,
                                   "key_code": event.keyCode, "flags": event.modifierFlags.rawValue,
                                   "characters": event.characters ?? ""])
        }
        if [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .scrollWheel].contains(event.type) {
            let point = event.locationInWindow
            let screen = event.cgEvent?.location ?? .zero
            received.append(["type": event.type.rawValue, "window": event.windowNumber,
                             "x": point.x, "y": point.y, "cg_x": screen.x, "cg_y": screen.y])
        }
        super.sendEvent(event)
    }
}

/// 使用与网页相同的向下增长坐标，真实滚动由 NSScrollView 处理。
final class ScrollDocument: NSView {
    override var isFlipped: Bool { true }
}

/// 延迟消费用于证明取消和超时不能提前恢复尚未被目标读取的剪贴板。
final class TextEditor: NSTextView {
    var pasteDelay: TimeInterval = 0
    var pasteRequests = 0
    var reportPaste: () -> Void = {}
    override func paste(_ sender: Any?) {
        pasteRequests += 1
        let delay = pasteDelay
        pasteDelay = 0
        reportPaste()
        if delay == 0 { consumePaste(sender) }
        else {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.consumePaste(sender)
            }
        }
    }
    private func consumePaste(_ sender: Any?) { super.paste(sender) }
}

/// 独立测试窗口将实际收到的事件写盘，避免把发送回执当成输入已经生效。
final class Surface: NSView {
    var report: () -> Void = {}
    var clicks: [Int] = []
    var releases = 0
    var drags = 0
    var scrolls = 0
    var pointerEvents: [[String: Any]] = []
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        record(event)
        clicks.append(event.clickCount)
        report()
    }
    override func mouseUp(with event: NSEvent) {
        record(event)
        releases += 1
        report()
    }
    override func mouseDragged(with event: NSEvent) {
        record(event)
        drags += 1
        report()
    }
    override func scrollWheel(with event: NSEvent) {
        record(event)
        scrolls += 1
        report()
    }
    func record(_ event: NSEvent) {
        let point = event.locationInWindow
        pointerEvents.append(["type": event.type.rawValue, "window": event.windowNumber,
                              "x": point.x, "y": point.y])
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
        "Computer use 独立验收窗口".draw(at: NSPoint(x: 50, y: 40), withAttributes: [
            .font: NSFont.systemFont(ofSize: 22), .foregroundColor: NSColor.labelColor,
        ])
    }
}

/// 仅创建自有窗口；控制文件只用于移动窗口和退出，不模拟任何被测输入。
final class Fixture: NSObject, NSApplicationDelegate, NSTextViewDelegate {
    let root: URL
    let surface = Surface(frame: NSRect(x: 0, y: 0, width: 560, height: 440))
    let editor = TextEditor(frame: NSRect(x: 50, y: 150, width: 460, height: 120))
    var window: NSWindow!
    var twin: NSWindow?
    let twinSurface = Surface(frame: .zero)
    var buttonClicks = 0
    let viewport = NSScrollView(frame: NSRect(x: 350, y: 50, width: 170, height: 80))
    var timer: Timer?
    init(root: URL) { self.root = root }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 140, y: 180, width: 560, height: 440),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Computer use 独立验收"
        (NSApp as? TestApplication)?.fixtureWindows.append(window)
        // 两种真实呈现方式共用验收：后台可见窗口与允许系统台前调度收起的普通窗口。
        if !CommandLine.arguments.contains("--stage-managed") {
            window.collectionBehavior = [.canJoinAllApplications]
        }
        window.animationBehavior = .none
        window.contentView = surface
        editor.delegate = self
        editor.reportPaste = { [weak self] in self?.save() }
        editor.font = NSFont.systemFont(ofSize: 20)
        // 后台启动没有应用级 key window；单编辑器菜单显式绑定真实控件，仍由 AppKit 分发快捷键。
        if !CommandLine.arguments.contains("--unrouted-menu") {
            NSApp.mainMenu?.item(at: 1)?.submenu?.items.forEach { $0.target = editor }
        }
        surface.addSubview(editor)
        let button = NSButton(title: "真实按钮", target: self, action: #selector(clickButton(_:)))
        button.frame = NSRect(x: 380, y: 300, width: 130, height: 32)
        surface.addSubview(button)
        viewport.documentView = ScrollDocument(frame: NSRect(x: 0, y: 0, width: 170, height: 800))
        viewport.hasVerticalScroller = true
        surface.addSubview(viewport)
        surface.report = { [weak self] in self?.save() }
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(editor)
        DispatchQueue.main.async { [weak self] in
            self?.window.displayIfNeeded()
            self?.save()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            guard let self else { return }
            save()
            let control = root.appendingPathComponent("control")
            guard let command = try? String(contentsOf: control, encoding: .utf8) else { return }
            try? FileManager.default.removeItem(at: control)
            if command == "quit" { NSApp.terminate(nil) }
            if command == "delay_paste" { editor.pasteDelay = 6; save() }
            if command == "hide" {
                window.orderOut(nil)
                twin?.orderOut(nil)
                save()
            }
            if command == "move" {
                window.setFrameOrigin(NSPoint(x: window.frame.minX + 30, y: window.frame.minY))
                save()
            }
            if command == "twin" {
                let other = NSWindow(contentRect: window.contentRect(forFrameRect: window.frame),
                                     styleMask: window.styleMask, backing: .buffered, defer: false)
                other.title = window.title
                other.collectionBehavior = [.canJoinAllApplications]
                other.animationBehavior = .none
                other.contentView = twinSurface
                other.setFrame(window.frame, display: true)
                other.orderFront(nil)
                twin = other
                (NSApp as? TestApplication)?.fixtureWindows.append(other)
                save()
            }
        }
    }
    func textDidChange(_ notification: Notification) { save() }
    @objc func clickButton(_ sender: NSButton) {
        buttonClicks += 1
        save()
    }
    func save() {
        // CG 与 AX 使用屏幕左上角；从实际视图换算，不假设标题栏高度或 Retina 比例。
        let screenTop = NSScreen.screens[0].frame.maxY
        // 只读检查实际 NSTextStorage；字符串回显不能证明 HTML 或 RTF 的样式已被消费。
        var fontRuns: [[String: Any]] = []
        if let storage = editor.textStorage {
            storage.enumerateAttribute(.font, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
                let bold = (value as? NSFont).map {
                    NSFontManager.shared.traits(of: $0).contains(.boldFontMask)
                } ?? false
                fontRuns.append(["location": range.location, "length": range.length, "bold": bold])
            }
        }
        func point(_ x: CGFloat, _ y: CGFloat) -> [String: Double] {
            let value = window.convertPoint(toScreen: surface.convert(NSPoint(x: x, y: y), to: nil))
            return ["x": Double(value.x), "y": Double(screenTop - value.y)]
        }
        let value: [String: Any] = [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "window_number": window.windowNumber,
            "ax_window_count": NSApp.accessibilityWindows()?.count ?? -1,
            "window_visible": window.isVisible,
            "native_frame": ["x": window.frame.minX, "y": screenTop - window.frame.maxY,
                             "width": window.frame.width, "height": window.frame.height],
            "cg_windows": (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []).filter {
                ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == ProcessInfo.processInfo.processIdentifier
            },
            "active": NSApp.isActive,
            "application_class": NSStringFromClass(type(of: NSApp)),
            "clicks": surface.clicks, "releases": surface.releases,
            "drags": surface.drags, "scrolls": surface.scrolls, "text": editor.string,
            "selection": ["location": editor.selectedRange().location, "length": editor.selectedRange().length],
            "font_runs": fontRuns,
            "paste_requests": editor.pasteRequests, "paste_delay": editor.pasteDelay,
            "key_window": NSApp.keyWindow?.windowNumber ?? 0,
            "paste_target": (NSApp.target(forAction: #selector(NSText.paste(_:)), to: nil, from: nil) as? NSObject).map { NSStringFromClass(type(of: $0)) } ?? "",
            "window_first_responder": window.firstResponder.map { NSStringFromClass(type(of: $0)) } ?? "",
            "menu_editor_target": (NSApp.mainMenu?.item(at: 1)?.submenu?.item(at: 2)?.target as? TextEditor) === editor,
            "pointer_events": surface.pointerEvents,
            "application_events": (NSApp as? TestApplication)?.received ?? [],
            "keyboard_events": (NSApp as? TestApplication)?.keyboardEvents ?? [],
            "twin_window": twin?.windowNumber ?? 0, "twin_clicks": twinSurface.clicks,
            "button_clicks": buttonClicks,
            "scroll_position": viewport.contentView.bounds.origin.y,
            "points": ["click": point(100, 100), "button": point(445, 315), "viewport": point(420, 90), "text": point(90, 180),
                       "scroll": point(100, 350), "from": point(100, 310), "to": point(200, 330)],
        ]
        do {
            try JSONSerialization.data(withJSONObject: value).write(
                to: root.appendingPathComponent("state.json"), options: .atomic)
        } catch {
            fputs("测试窗口写入回执失败：\(error)\n", stderr)
            NSApp.terminate(nil)
        }
    }
}

let fixtureRoot = CommandLine.arguments.dropFirst().last ?? Bundle.main.object(forInfoDictionaryKey: "NoemoriFixtureRoot") as? String
guard let fixtureRoot else { fatalError("独立测试窗口缺少输出目录") }
let root = URL(fileURLWithPath: fixtureRoot)
let application = TestApplication.shared
application.setActivationPolicy(.regular)
// 独立 Swift 程序没有 nib 提供菜单；建立正常 AppKit 键盘等价项和应用层 UI 生命周期。
let menu = NSMenu()
let appItem = NSMenuItem(title: "Computer Window Test", action: nil, keyEquivalent: "")
appItem.submenu = NSMenu(title: "Computer Window Test")
appItem.submenu?.addItem(withTitle: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
menu.addItem(appItem)
let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
editItem.submenu = NSMenu(title: "编辑")
editItem.submenu?.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
editItem.submenu?.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editItem.submenu?.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
menu.addItem(editItem)
let windowsItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
windowsItem.submenu = NSMenu(title: "窗口")
menu.addItem(windowsItem)
application.mainMenu = menu
application.windowsMenu = windowsItem.submenu
let fixture = Fixture(root: root)
application.delegate = fixture
application.run()
