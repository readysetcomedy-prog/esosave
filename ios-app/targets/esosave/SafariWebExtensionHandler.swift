import SafariServices
import Vision
import UIKit
import os.log

// The extension's native side. The page script asks, through the background script:
//   ping                -> is the app here, does it scan
//   scans               -> the pages the app scanned and left in the shared container
//                          (a facesheet also carries the text read off its pages)
//   consume {id}        -> that scan has been attached; drop it
//   ocr {image: base64} -> the text on one image (an uploaded facesheet, for the fill)
let appGroup = "group.com.ruralmedems.esosave"

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        var message: [String: Any] = [:]
        if let m = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] { message = m }
        else if let m = item?.userInfo?["message"] as? [String: Any] { message = m }
        let type = message["type"] as? String ?? ""
        var reply: [String: Any] = ["ok": true]
        switch type {
        case "ping":
            reply = ["ok": true, "scanner": true, "app": Bundle.main.bundleIdentifier ?? ""]
        case "scans":
            reply = ["ok": true, "scans": Scans.list()]
        case "claim":
            if let id = message["id"] as? String, let scan = Scans.claim(id) { reply = ["ok": true, "scan": scan] }
            else { reply = ["ok": true, "scan": NSNull()] }
        case "consume":
            if let id = message["id"] as? String { Scans.consume(id) }
        case "ocr":
            if let b64 = message["image"] as? String, let data = Data(base64Encoded: b64), let img = UIImage(data: data) {
                reply = ["ok": true, "text": OCR.text(of: img)]
            } else {
                reply = ["ok": false, "error": "no image"]
            }
        default:
            break
        }
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

enum Scans {
    static var dir: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?.appendingPathComponent("scans", isDirectory: true)
    }
    static var takenDir: URL? { dir?.appendingPathComponent("taken", isDirectory: true) }
    static func safe(_ id: String) -> String { id.replacingOccurrences(of: "/", with: "").replacingOccurrences(of: "..", with: "") }
    // Every scan the app left and no tab has claimed yet, oldest first, without the pages.
    static func list() -> [[String: Any]] {
        guard let dir = dir, let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        var out: [[String: Any]] = []
        for name in names.sorted() where name.hasSuffix(".json") {
            guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)), let scan = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            var head: [String: Any] = [:]
            for k in ["id", "type", "record", "incident", "at"] { if let v = scan[k] { head[k] = v } }
            out.append(head)
        }
        return out
    }
    // One tab takes the scan: the file moves aside so no other tab lists it again. A facesheet
    // gets its text read here, once.
    static func claim(_ id: String) -> [String: Any]? {
        guard let dir = dir, let taken = takenDir else { return nil }
        let from = dir.appendingPathComponent(safe(id) + ".json"), to = taken.appendingPathComponent(safe(id) + ".json")
        try? FileManager.default.createDirectory(at: taken, withIntermediateDirectories: true)
        guard (try? FileManager.default.moveItem(at: from, to: to)) != nil else { return nil }
        guard let data = try? Data(contentsOf: to), var scan = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        if (scan["type"] as? String) == "Facesheet", scan["text"] == nil, let pages = scan["pages"] as? [String] {
            var text = ""
            for p in pages { if let d = Data(base64Encoded: p), let img = UIImage(data: d) { text += OCR.text(of: img) + "\n" } }
            scan["text"] = text
            if let d = try? JSONSerialization.data(withJSONObject: scan) { try? d.write(to: to) }
        }
        return scan
    }
    static func consume(_ id: String) {
        for d in [dir, takenDir].compactMap({ $0 }) { try? FileManager.default.removeItem(at: d.appendingPathComponent(safe(id) + ".json")) }
    }
}

enum OCR {
    // The text on a page: one line per printed row, top to bottom, the cells of a row (a label
    // and its value, the two columns of a facesheet) left to right separated by " | ".
    static func text(of image: UIImage) -> String {
        guard let cg = image.cgImage else { return "" }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(cgImage: cg, orientation: cgOrientation(image.imageOrientation), options: [:])
        do { try handler.perform([request]) } catch { return "" }
        let obs = (request.results ?? []).compactMap { o -> (String, CGRect)? in
            guard let t = o.topCandidates(1).first?.string, !t.isEmpty else { return nil }
            return (t, o.boundingBox)
        }
        // Vision's origin is the bottom-left corner: higher midY is higher on the page
        let sorted = obs.sorted { $0.1.midY > $1.1.midY }
        var rows: [[(String, CGRect)]] = []
        for o in sorted {
            if let last = rows.last, let first = last.first {
                let tol = max(first.1.height, o.1.height) * 0.6
                if abs(first.1.midY - o.1.midY) <= tol { rows[rows.count - 1].append(o); continue }
            }
            rows.append([o])
        }
        return rows.map { row in row.sorted { $0.1.minX < $1.1.minX }.map { $0.0 }.joined(separator: " | ") }.joined(separator: "\n")
    }
    static func cgOrientation(_ o: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch o {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }
}
