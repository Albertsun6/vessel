// Polls /api/health/heartbeat every few seconds. Exposes a small status struct
// so SettingsView (and future toolbar badges) can render "Mac is alive" indicator.
//
// Lightweight — endpoint returns in <5ms.
//
// Battery / heat behavior:
//   - Healthy: poll every `baseIntervalSec` (5s by default).
//   - Unreachable: exponential backoff 10→30→60s ceil so a sustained outage
//     stops hammering the network every 5s (the original "device gets hot"
//     symptom). First successful fetch resets the interval to base.
//   - Background: enterBackground() kills the timer entirely so iOS doesn't
//     burn its BG runtime window on retries during prolonged outages.
//     enterForeground() restarts at base interval.

import Foundation
import SwiftUI

@Observable
final class HeartbeatMonitor {
    struct Snapshot: Codable, Equatable {
        var startedAt: Int64
        var uptimeSec: Int
        var lastSpawnAt: Int64?
        var lastCompletionAt: Int64?
        var lastErrorAt: Int64?
        var totalSpawns: Int
        var totalCompletions: Int
        var totalErrors: Int
        var activeRunCount: Int
        var notificationChannelCount: Int
        var now: Int64
    }

    enum Status {
        case unknown            // never fetched
        case healthy            // last fetch ok within freshnessSec
        case stale(secs: Int)   // last fetch was a while ago
        case unreachable(error: String)
    }

    var snapshot: Snapshot?
    var status: Status = .unknown
    var lastFetchAt: Date?

    private let baseURL: () -> URL
    private let baseIntervalSec: Double
    private let freshnessSec: Double = 12 // status flips to .stale after this
    /// Caps the unreachable backoff. 60s aligns with WebSocketClient.reconnectDelay ceiling.
    private let maxIntervalSec: Double = 60
    /// Current poll interval — mutates with backoff. Starts at base, climbs on
    /// unreachable, resets on first .healthy fetch.
    private var currentIntervalSec: Double
    private var timer: Timer?
    private var task: Task<Void, Never>?
    /// `start()` was called at least once. Used by enterForeground to decide
    /// whether to re-arm the timer (don't auto-start before the app is ready).
    private var hasStarted: Bool = false

    init(baseURL: @escaping () -> URL, intervalSec: Double = 5.0) {
        self.baseURL = baseURL
        self.baseIntervalSec = intervalSec
        self.currentIntervalSec = intervalSec
    }

    @MainActor
    func start() {
        hasStarted = true
        stop()
        currentIntervalSec = baseIntervalSec
        scheduleTimer()
        fetchNow()
    }

    @MainActor
    func stop() {
        timer?.invalidate()
        timer = nil
        task?.cancel()
    }

    /// App moves to background: kill the timer so iOS doesn't burn its BG
    /// runtime window polling a possibly-unreachable backend (the heat fix).
    /// Mirror of WebSocketClient.enterBackground.
    @MainActor
    func enterBackground() {
        timer?.invalidate()
        timer = nil
        task?.cancel()
    }

    /// App returns to foreground: re-arm at base interval (don't carry stale
    /// backoff from before backgrounding — let one fresh probe determine state).
    @MainActor
    func enterForeground() {
        guard hasStarted else { return }
        currentIntervalSec = baseIntervalSec
        scheduleTimer()
        fetchNow()
    }

    @MainActor
    private func scheduleTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: currentIntervalSec, repeats: true) { [weak self] _ in
            self?.fetchNow()
        }
        timer?.tolerance = currentIntervalSec * 0.2
    }

    @MainActor
    func fetchNow() {
        task?.cancel()
        task = Task { [weak self] in
            await self?.fetch()
        }
    }

    private func fetch() async {
        let url = baseURL().appendingPathComponent("api/health/heartbeat")
        var req = URLRequest(url: url)
        req.timeoutInterval = 4
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
                await update(status: .unreachable(error: "HTTP \(code)"))
                return
            }
            let snap = try JSONDecoder().decode(Snapshot.self, from: data)
            await update(snap: snap)
        } catch {
            await update(status: .unreachable(error: shortError(error)))
        }
    }

    @MainActor
    private func update(snap: Snapshot) {
        self.snapshot = snap
        self.status = .healthy
        self.lastFetchAt = Date()
        // Healthy fetch → backoff resets so a future fresh outage starts at
        // baseIntervalSec instead of whatever cap (60s) the last outage hit.
        if currentIntervalSec != baseIntervalSec {
            currentIntervalSec = baseIntervalSec
            scheduleTimer()
        }
    }

    @MainActor
    private func update(status: Status) {
        self.status = status
        // Don't clear snapshot — old data is useful while reconnecting.
        // Unreachable → grow the interval (10s → 30s → 60s ceil). 5s base
        // would otherwise keep hammering during a sustained outage, which is
        // exactly the "device heats up while disconnected" symptom.
        if case .unreachable = status {
            let next = min(maxIntervalSec, max(currentIntervalSec * 2, 10))
            if next != currentIntervalSec {
                currentIntervalSec = next
                scheduleTimer()
            }
        }
    }

    private func shortError(_ error: Error) -> String {
        let s = error.localizedDescription
        return s.count > 60 ? String(s.prefix(60)) + "…" : s
    }
}
