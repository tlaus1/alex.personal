import SwiftUI

// Host app for the widget extension. macOS requires a real app to contain a
// WidgetKit extension; this window just explains how to add the widget.
@main
struct AlexdbWidgetsApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(alignment: .leading, spacing: 14) {
                Text("alexdb Widgets")
                    .font(.system(size: 24, weight: .semibold))
                Text("The widget is installed. To put it on your desktop:")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 8) {
                    Label("Right-click the desktop", systemImage: "1.circle.fill")
                    Label("Choose Edit Widgets", systemImage: "2.circle.fill")
                    Label("Search for alexdb and drag it out", systemImage: "3.circle.fill")
                }
                .font(.system(size: 13))
                Spacer()
                Text("Keep this app in your Applications folder so macOS keeps offering the widget.")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
            .padding(28)
            .frame(width: 420, height: 260)
        }
        .windowResizability(.contentSize)
    }
}
