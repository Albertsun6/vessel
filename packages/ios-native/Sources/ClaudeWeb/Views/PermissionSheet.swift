import SwiftUI

struct PermissionSheet: View {
    let request: PermissionRequest
    let client: BackendClient
    let onDecision: (PermissionDecision) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var autoAllowThisTurn = false
    // ADR-023 Phase C: "deny + tell Claude what to do instead".
    @State private var denyInstruction = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("工具") {
                    Text(request.toolName).font(.title3.bold())
                }
                Section("内容") {
                    Text(request.preview)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                        .lineLimit(10)
                }
                Section("后续处理") {
                    Toggle(
                        isOn: $autoAllowThisTurn,
                        label: {
                            Text("本轮对话中的 \(request.toolName) 总是允许")
                                .font(.subheadline)
                        }
                    )
                }
                Section("拒绝并指示 Claude 改做什么（可选）") {
                    TextField("例如：不要删文件，改成移动到 .trash/", text: $denyInstruction, axis: .vertical)
                        .lineLimit(1...4)
                    Button {
                        // Deny + forward the instruction as the hook deny
                        // reason so Claude sees it and can redirect.
                        client.replyPermission(request, decision: .deny,
                                               message: denyInstruction.trimmingCharacters(in: .whitespacesAndNewlines))
                        dismiss()
                    } label: {
                        Label("拒绝并发送指示", systemImage: "arrow.uturn.left.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(denyInstruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Section {
                    Button(role: .destructive) {
                        onDecision(.deny)
                        dismiss()
                    } label: {
                        Label("拒绝", systemImage: "xmark.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                    Button {
                        if autoAllowThisTurn {
                            client.allowToolForRun(request.runId, request.toolName)
                        }
                        onDecision(.allow)
                        dismiss()
                    } label: {
                        Label("允许", systemImage: "checkmark.circle.fill")
                            .frame(maxWidth: .infinity)
                            .fontWeight(.semibold)
                    }
                }
            }
            .navigationTitle("权限请求")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
