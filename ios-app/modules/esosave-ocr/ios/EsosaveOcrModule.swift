import ExpoModulesCore
import UIKit
import Vision

// The app's own text reader: the same reading the Safari extension does on a claimed scan, run
// here right after the scan so the crew can see what the facesheet gave before going back.
public class EsosaveOcrModule: Module {
  public func definition() -> ModuleDefinition {
    Name("EsosaveOcr")
    AsyncFunction("read") { (base64: String) -> String in
      guard let data = Data(base64Encoded: base64), let img = UIImage(data: data) else { return "" }
      return OCR.text(of: img)
    }
  }
}

enum OCR {
    // The text on a page, read twice: once as printed (no spelling correction, so a name or a
    // number is never "corrected" into something else) and once with correction on and the
    // facesheet's own labels taught as words (so a label the plain read misspelt still reads).
    // The second read follows the first, and the fill takes the first value it finds for each
    // label, so the plain read wins wherever both have it. Small print is enlarged first.
    static let labels = ["Patient", "Guarantor", "Subscriber", "Insurance", "Insured", "Policy", "Coverage", "Primary", "Secondary", "DOB", "SSN", "MRN", "Sex", "Gender", "Race", "Ethnicity", "Address", "City", "State", "Zip", "Phone", "Mobile", "Cell", "Employer", "Relationship", "Marital", "Religion", "Language", "Account", "Admit", "Attending", "Physician", "Medicare", "Medicaid", "Group", "Payor", "Payer", "Carrier", "Name", "Birth", "Home"]
    static func text(of image: UIImage) -> String {
        let img = enlarged(image)
        let plain = read(img, correct: false)
        let corrected = read(img, correct: true)
        if corrected.isEmpty || corrected == plain { return plain }
        return plain + "\n— second read —\n" + corrected
    }
    // a page narrower than 2400 px is drawn larger before reading: small print reads better
    static func enlarged(_ image: UIImage) -> UIImage {
        let w = image.size.width * image.scale
        guard w > 0, w < 2400 else { return image }
        let f = 2400 / w
        let size = CGSize(width: image.size.width * f, height: image.size.height * f)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }
    // one line per printed row, top to bottom, the cells of a row (a label and its value, the
    // two columns of a facesheet) left to right separated by " | "
    static func read(_ image: UIImage, correct: Bool) -> String {
        guard let cg = image.cgImage else { return "" }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = correct
        if correct { request.customWords = labels }
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
