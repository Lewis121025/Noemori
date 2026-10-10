import AppKit

// AppKit 的 HTML 消费需要主线程；独立进程只读取 UUID 命名剪贴板，不创建窗口或激活应用。
guard CommandLine.arguments.count == 2 else { fatalError("缺少独立剪贴板名称") }
let board = NSPasteboard(name: NSPasteboard.Name(CommandLine.arguments[1]))
let editor = NSTextView()
let consumed = editor.readSelection(from: board, type: .html)
var bold = !editor.string.isEmpty
if let storage = editor.textStorage {
    storage.enumerateAttribute(.font, in: NSRange(location: 0, length: storage.length)) { value, _, _ in
        bold = bold && (value as? NSFont).map {
            NSFontManager.shared.traits(of: $0).contains(.boldFontMask)
        } ?? false
    }
} else {
    bold = false
}
let output: [String: Any] = ["consumed": consumed, "text": editor.string, "bold": bold]
let data = try JSONSerialization.data(withJSONObject: output)
print(String(decoding: data, as: UTF8.self))
