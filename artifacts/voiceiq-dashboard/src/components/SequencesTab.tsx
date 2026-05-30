import { useEffect, useState, useCallback } from "react";
import {
  getSmsSequences,
  createSmsSequence,
  updateSmsSequence,
  deleteSmsSequence,
  getBusinessConfig,
} from "../lib/api";
import {
  Plus,
  X,
  Trash2,
  Loader2,
  ArrowUpRight,
  Lock,
  ChevronRight,
  Zap,
  Power,
  PowerOff,
  Users,
  CheckCircle,
  XCircle,
  Clock,
  Play,
  Copy,
} from "lucide-react";

const TRIGGERS = [
  { id: "after_any_call", label: "After any call", desc: "Starts after every completed call" },
  { id: "after_hot_lead", label: "After hot lead call", desc: "Starts when caller is scored as a hot lead" },
  { id: "after_appointment_booked", label: "After appointment booked", desc: "Starts when an appointment is confirmed" },
  { id: "after_missed_appointment", label: "After missed appointment", desc: "Starts when a caller doesn't show up" },
];

const DELAY_UNITS = [
  { id: "hour", label: "hour(s)" },
  { id: "day", label: "day(s)" },
  { id: "week", label: "week(s)" },
];

const TEMPLATES = [
  {
    name: "Appointment Reminder",
    trigger: "after_appointment_booked",
    steps: [
      { delay_value: 1, delay_unit: "hour", message: "Hi! This is {business}. We've booked your appointment. We'll see you soon!" },
      { delay_value: 1, delay_unit: "day", message: "Reminder: Your appointment is tomorrow. Reply to confirm or call us to reschedule." },
    ],
  },
  {
    name: "Hot Lead Follow-up",
    trigger: "after_hot_lead",
    steps: [
      { delay_value: 1, delay_unit: "day", message: "Hi, thanks for calling {business}! Did you have any questions we can answer?" },
      { delay_value: 3, delay_unit: "day", message: "Still interested? We'd love to help. Call us anytime." },
      { delay_value: 7, delay_unit: "day", message: "Last follow-up — we're here if you need us. Have a great day!" },
    ],
  },
  {
    name: "Post-Call Check-in",
    trigger: "after_any_call",
    steps: [
      { delay_value: 2, delay_unit: "hour", message: "Thanks for calling {business}! Is there anything else we can help with?" },
      { delay_value: 3, delay_unit: "day", message: "Just checking in — hope we answered all your questions. We're here if you need us!" },
    ],
  },
];

type Step = { delay_value: number; delay_unit: string; message: string };

export default function SequencesTab() {
  const [sequences, setSequences] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [userPlan, setUserPlan] = useState("starter");
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const [seqName, setSeqName] = useState("");
  const [seqTrigger, setSeqTrigger] = useState("after_any_call");
  const [steps, setSteps] = useState<Step[]>([{ delay_value: 1, delay_unit: "hour", message: "" }]);
  const [stopOnReply, setStopOnReply] = useState(true);
  const [stopOnAppointment, setStopOnAppointment] = useState(true);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 3000); };

  const sequenceAllowed = ["professional", "growth", "business", "enterprise"].includes(userPlan);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [config, seqData] = await Promise.all([
        getBusinessConfig().catch(() => null),
        getSmsSequences().catch(() => ({ sequences: [] })),
      ]);
      if (config?.config?.plan) setUserPlan(config.config.plan);
      setSequences(seqData.sequences || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const resetForm = () => {
    setSeqName("");
    setSeqTrigger("after_any_call");
    setSteps([{ delay_value: 1, delay_unit: "hour", message: "" }]);
    setStopOnReply(true);
    setStopOnAppointment(true);
  };

  const applyTemplate = (tpl: typeof TEMPLATES[0]) => {
    setSeqName(tpl.name);
    setSeqTrigger(tpl.trigger);
    setSteps([...tpl.steps]);
  };

  const addStep = () => {
    if (steps.length >= 10) return;
    setSteps([...steps, { delay_value: 1, delay_unit: "day", message: "" }]);
  };

  const removeStep = (idx: number) => {
    if (steps.length <= 1) return;
    setSteps(steps.filter((_, i) => i !== idx));
  };

  const updateStep = (idx: number, field: keyof Step, value: any) => {
    setSteps(steps.map((s, i) => i === idx ? { ...s, [field]: value } : s));
  };

  const handleCreate = async () => {
    if (!seqName || steps.some((s) => !s.message)) return;
    setSaving(true);
    try {
      await createSmsSequence({
        name: seqName,
        trigger: seqTrigger,
        steps,
        stop_on_reply: stopOnReply,
        stop_on_appointment: stopOnAppointment,
      });
      showToast("Sequence created!");
      setShowCreate(false);
      resetForm();
      await loadData();
    } catch (e: any) {
      showToast(e.message || "Failed to create sequence");
    }
    setSaving(false);
  };

  const toggleActive = async (seq: any) => {
    try {
      await updateSmsSequence(seq.id, { active: !seq.active });
      setSequences(sequences.map((s) => s.id === seq.id ? { ...s, active: !s.active } : s));
      showToast(seq.active ? "Sequence paused" : "Sequence activated");
    } catch {
      showToast("Failed to update sequence");
    }
  };

  const handleDelete = async (seq: any) => {
    if (!confirm(`Delete sequence "${seq.name}"? This will also remove all enrollments.`)) return;
    try {
      await deleteSmsSequence(seq.id);
      setSequences(sequences.filter((s) => s.id !== seq.id));
      showToast("Sequence deleted");
    } catch {
      showToast("Failed to delete sequence");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-[#2E75B6] animate-spin" />
      </div>
    );
  }

  if (!sequenceAllowed) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
        <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Lock className="w-8 h-8 text-gray-400" />
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Automated SMS Sequences</h3>
        <p className="text-sm text-gray-500 max-w-md mx-auto mb-6">
          Automated follow-up sequences are available on Professional plan and above. Set up multi-step SMS campaigns that fire automatically after calls.
        </p>
        <a
          href="/settings?tab=billing"
          className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] shadow-md shadow-[#2E75B6]/20"
        >
          <ArrowUpRight className="w-4 h-4" /> Upgrade to Professional
        </a>
      </div>
    );
  }

  return (
    <div>
      {toast && (
        <div className="fixed top-4 right-4 z-[60] bg-gray-900 text-white px-4 py-2.5 rounded-xl text-sm shadow-lg animate-in slide-in-from-top-2">
          {toast}
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Active Sequences</h2>
          <p className="text-xs text-gray-500 mt-0.5">Automated follow-up messages sent after calls</p>
        </div>
        <button
          onClick={() => { resetForm(); setShowCreate(true); }}
          className="flex items-center gap-2 px-4 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] shadow-md shadow-[#2E75B6]/20"
        >
          <Plus className="w-4 h-4" /> New Sequence
        </button>
      </div>

      {sequences.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <Zap className="w-10 h-10 text-gray-200 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-500">No sequences yet</p>
          <p className="text-xs text-gray-400 mt-1 max-w-sm mx-auto">
            Create an automated sequence to follow up with callers via SMS. Choose a trigger and add message steps.
          </p>
          <button
            onClick={() => { resetForm(); setShowCreate(true); }}
            className="mt-4 px-5 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-medium hover:bg-[#2563a0]"
          >
            Create your first sequence
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {sequences.map((seq: any) => {
            const stepsArr = typeof seq.steps === "string" ? JSON.parse(seq.steps) : seq.steps;
            const triggerLabel = TRIGGERS.find((t) => t.id === seq.trigger)?.label || seq.trigger;
            const stats = seq.stats || { enrolled: 0, completed: 0, stopped: 0, active: 0 };
            return (
              <div key={seq.id} className="bg-white rounded-xl border border-gray-200 p-5">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-gray-900">{seq.name}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        seq.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                      }`}>
                        {seq.active ? "Active" : "Paused"}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Trigger: <span className="font-medium">{triggerLabel}</span> &middot; {stepsArr.length} step{stepsArr.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => toggleActive(seq)}
                      className={`p-2 rounded-lg transition-colors ${
                        seq.active ? "text-green-600 hover:bg-green-50" : "text-gray-400 hover:bg-gray-100"
                      }`}
                      title={seq.active ? "Pause" : "Activate"}
                    >
                      {seq.active ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => handleDelete(seq)}
                      className="p-2 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-3 mt-3">
                  {[
                    { label: "Enrolled", value: stats.enrolled, icon: Users, color: "blue" },
                    { label: "Active", value: stats.active, icon: Play, color: "amber" },
                    { label: "Completed", value: stats.completed, icon: CheckCircle, color: "green" },
                    { label: "Stopped", value: stats.stopped, icon: XCircle, color: "red" },
                  ].map((s) => {
                    const Icon = s.icon;
                    return (
                      <div key={s.label} className="bg-gray-50 rounded-lg p-2.5 text-center">
                        <Icon className={`w-3.5 h-3.5 mx-auto mb-1 text-${s.color}-500`} />
                        <p className="text-lg font-bold text-gray-900">{s.value}</p>
                        <p className="text-[10px] text-gray-500">{s.label}</p>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-3 flex items-center gap-2 overflow-x-auto">
                  {stepsArr.map((step: Step, i: number) => (
                    <div key={i} className="flex items-center gap-1.5 shrink-0">
                      {i > 0 && <ChevronRight className="w-3 h-3 text-gray-300" />}
                      <div className="bg-blue-50 rounded-lg px-2.5 py-1.5">
                        <p className="text-[10px] text-blue-600 font-medium">
                          Step {i + 1}: {step.delay_value} {step.delay_unit}{step.delay_value !== 1 ? "s" : ""}
                        </p>
                        <p className="text-[10px] text-gray-600 truncate max-w-[140px]">{step.message}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-2 flex items-center gap-3 text-[10px] text-gray-400">
                  {seq.stop_on_reply && <span>Stops on reply</span>}
                  {seq.stop_on_appointment && <span>Stops on appointment</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white rounded-t-2xl z-10">
              <div>
                <h3 className="font-semibold text-lg">New Sequence</h3>
                <p className="text-xs text-gray-500">Automated follow-up messages after calls</p>
              </div>
              <button onClick={() => setShowCreate(false)}>
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2">Start from a template</p>
                <div className="grid grid-cols-3 gap-2">
                  {TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.name}
                      onClick={() => applyTemplate(tpl)}
                      className="text-left p-3 bg-gray-50 rounded-xl border border-gray-200 hover:border-[#2E75B6] hover:bg-blue-50/30 transition-colors"
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <Copy className="w-3 h-3 text-[#2E75B6]" />
                        <p className="text-xs font-semibold text-gray-900">{tpl.name}</p>
                      </div>
                      <p className="text-[10px] text-gray-500">{tpl.steps.length} steps</p>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-700 mb-1 block">Sequence Name</label>
                <input
                  value={seqName}
                  onChange={(e) => setSeqName(e.target.value)}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  placeholder="Post-appointment follow-up"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-gray-700 mb-2 block">Trigger — When to start</label>
                <div className="grid grid-cols-2 gap-2">
                  {TRIGGERS.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setSeqTrigger(t.id)}
                      className={`text-left p-3 rounded-xl border transition-colors ${
                        seqTrigger === t.id
                          ? "border-[#2E75B6] bg-blue-50/50"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <p className={`text-xs font-medium ${seqTrigger === t.id ? "text-[#2E75B6]" : "text-gray-900"}`}>{t.label}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">{t.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-700 mb-2 block">Steps (up to 10)</label>
                <div className="space-y-3">
                  {steps.map((step, idx) => (
                    <div key={idx} className="bg-gray-50 rounded-xl p-4 border border-gray-200">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-gray-700">Step {idx + 1}</span>
                        {steps.length > 1 && (
                          <button onClick={() => removeStep(idx)} className="p-1 text-gray-400 hover:text-red-500">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs text-gray-500 shrink-0">Send after</span>
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={step.delay_value}
                          onChange={(e) => updateStep(idx, "delay_value", parseInt(e.target.value) || 1)}
                          className="w-16 px-2 py-1.5 border border-gray-200 rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                        />
                        <select
                          value={step.delay_unit}
                          onChange={(e) => updateStep(idx, "delay_unit", e.target.value)}
                          className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                        >
                          {DELAY_UNITS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                        </select>
                      </div>
                      <textarea
                        value={step.message}
                        onChange={(e) => updateStep(idx, "message", e.target.value.slice(0, 160))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm h-16 resize-none focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                        placeholder="Hi! Thanks for calling..."
                      />
                      <p className={`text-[10px] text-right mt-0.5 ${step.message.length > 150 ? "text-amber-600" : "text-gray-400"}`}>
                        {step.message.length}/160
                      </p>
                    </div>
                  ))}
                </div>
                {steps.length < 10 && (
                  <button
                    onClick={addStep}
                    className="mt-2 flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#2E75B6] hover:bg-blue-50 rounded-lg transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Step
                  </button>
                )}
              </div>

              <div>
                <label className="text-xs font-medium text-gray-700 mb-2 block">Stop Conditions</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl cursor-pointer hover:bg-gray-100 transition-colors">
                    <input
                      type="checkbox"
                      checked={stopOnReply}
                      onChange={(e) => setStopOnReply(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 text-[#2E75B6] focus:ring-[#2E75B6]"
                    />
                    <div>
                      <p className="text-xs font-medium text-gray-900">Stop if they reply</p>
                      <p className="text-[10px] text-gray-500">Pauses the sequence when the contact sends any SMS</p>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl cursor-pointer hover:bg-gray-100 transition-colors">
                    <input
                      type="checkbox"
                      checked={stopOnAppointment}
                      onChange={(e) => setStopOnAppointment(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 text-[#2E75B6] focus:ring-[#2E75B6]"
                    />
                    <div>
                      <p className="text-xs font-medium text-gray-900">Stop if they book an appointment</p>
                      <p className="text-[10px] text-gray-500">Pauses if the contact books during the sequence</p>
                    </div>
                  </label>
                  <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl opacity-60">
                    <input type="checkbox" checked disabled className="w-4 h-4 rounded border-gray-300 text-[#2E75B6]" />
                    <div>
                      <p className="text-xs font-medium text-gray-900">Always stop on STOP reply</p>
                      <p className="text-[10px] text-gray-500">Required — contacts who reply STOP are always removed</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-5 border-t border-gray-100 flex justify-end gap-2 sticky bottom-0 bg-white rounded-b-2xl">
              <button
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={saving || !seqName || steps.some((s) => !s.message)}
                className="px-6 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-medium hover:bg-[#2563a0] disabled:opacity-50 flex items-center gap-1.5"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Create Sequence
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
