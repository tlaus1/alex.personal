import WidgetKit
import SwiftUI

// MARK: - Data

/// What status.py serves over the Cloudflare tunnel.
struct PCStatus: Decodable {
    let name: String?
    let cpu: String?
    let gpu: String?
    let ram: String?
    let net: String?
    let online: Bool?
}

enum StatusLoader {
    static let endpoint = URL(string: "https://status.alexdb.xyz/api/status")!

    /// Returns nil when the PC (or its tunnel) is unreachable, which the widget
    /// renders as "Offline" rather than as an error.
    static func fetch() async -> PCStatus? {
        var request = URLRequest(url: endpoint)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 10
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              // A dead tunnel answers with a Cloudflare error page, not JSON.
              (200..<300).contains(http.statusCode),
              let status = try? JSONDecoder().decode(PCStatus.self, from: data)
        else { return nil }
        return status
    }
}

// MARK: - Timeline

struct StatusEntry: TimelineEntry {
    let date: Date
    let status: PCStatus?
}

struct StatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> StatusEntry {
        StatusEntry(date: Date(), status: PCStatus(name: "AlexPC", cpu: "Ryzen 7 7800X3D",
                                                  gpu: "RTX 5070", ram: "32 GB",
                                                  net: "10 Gbps", online: true))
    }

    func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
        Task { completion(StatusEntry(date: Date(), status: await StatusLoader.fetch())) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
        Task {
            let entry = StatusEntry(date: Date(), status: await StatusLoader.fetch())
            // WidgetKit throttles refreshes; 15 minutes is about as often as the
            // system will honour for a network-backed widget.
            let next = Calendar.current.date(byAdding: .minute, value: 15, to: Date())!
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

// MARK: - Views

private struct StatusDot: View {
    let online: Bool
    var body: some View {
        Circle()
            .fill(online ? Color.green : Color.red)
            .frame(width: 8, height: 8)
    }
}

struct AlexdbWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StatusEntry

    private var isOnline: Bool { entry.status != nil }
    private var machine: String { entry.status?.name ?? "AlexPC" }

    /// "AMD Ryzen 7 7800X3D 8-Core Processor" is too long for a small widget.
    private func shorten(_ text: String?) -> String {
        guard let text else { return "--" }
        return text
            .replacingOccurrences(of: #"\s*\d+-Core Processor"#, with: "",
                                  options: .regularExpression)
            .replacingOccurrences(of: "NVIDIA GeForce ", with: "")
            .replacingOccurrences(of: "AMD ", with: "")
            .trimmingCharacters(in: .whitespaces)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(machine.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .tracking(1.1)

            HStack(spacing: 6) {
                StatusDot(online: isOnline)
                Text(isOnline ? "Online" : "Offline")
                    .font(.system(size: 17, weight: .semibold))
            }

            if family != .systemSmall, let s = entry.status {
                VStack(alignment: .leading, spacing: 3) {
                    row("GPU", shorten(s.gpu))
                    row("CPU", shorten(s.cpu))
                    row("RAM", s.ram ?? "--")
                }
                .padding(.top, 2)
            } else if !isOnline {
                Text("tunnel unreachable")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.tertiary)
                .frame(width: 26, alignment: .leading)
            Text(value)
                .font(.system(size: 11))
                .lineLimit(1)
        }
    }
}

// MARK: - Widget

struct AlexdbWidget: Widget {
    let kind = "AlexdbStatusWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: StatusProvider()) { entry in
            AlexdbWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("AlexPC")
        .description("Whether your PC is online, with its specs.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct AlexdbWidgetBundle: WidgetBundle {
    var body: some Widget { AlexdbWidget() }
}
