import SwiftUI

/// ADR-023 Phase C: renders a paused Vessel workflow's HITL step so the user
/// can pick an option. Workflows are a workflowId-keyed broadcast subsystem
/// (not runId-bound) and survive disconnect server-side — this is pure
/// additive UI; the choice is POSTed to /api/vessel/workflows/:id/resume.
struct WorkflowChoiceSheet: View {
    let choice: WorkflowChoice
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("工作流暂停（第 \(choice.step) 步）") {
                    Text(choice.message)
                        .font(.body)
                        .textSelection(.enabled)
                }
                Section("请选择") {
                    if choice.options.isEmpty {
                        Button {
                            onPick("continue")
                            dismiss()
                        } label: {
                            Label("继续", systemImage: "play.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                    } else {
                        ForEach(choice.options, id: \.self) { opt in
                            Button {
                                onPick(opt)
                                dismiss()
                            } label: {
                                Text(opt).frame(maxWidth: .infinity)
                            }
                        }
                    }
                }
            }
            .navigationTitle("工作流选择")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
