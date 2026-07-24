"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle, Send, ChevronDown, ChevronUp } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { isRemoteMode } from "@/lib/remote-connection";
import type { QuestionRequest, QuestionItem, QuestionOptionItem } from "@/types/streaming";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface QuestionPromptProps {
  question: QuestionRequest;
  onRespond: (answer: string | Record<string, string>) => void;
}

/* ------------------------------------------------------------------ */
/*  Legacy helpers (single-question mode)                              */
/* ------------------------------------------------------------------ */

type LegacyOption = { label: string; description?: string };

function normalizeLegacyOptions(raw: unknown): LegacyOption[] {
  if (!Array.isArray(raw)) return [];
  const normalized: LegacyOption[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const label = item.trim();
      if (label) normalized.push({ label });
      continue;
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const rawLabel = obj.label ?? obj.value ?? obj.title;
      if (typeof rawLabel !== "string") continue;
      const label = rawLabel.trim();
      if (!label) continue;
      const description = typeof obj.description === "string" ? obj.description : undefined;
      normalized.push({ label, description });
    }
  }
  return normalized;
}

/* ------------------------------------------------------------------ */
/*  Legacy single-question UI                                          */
/* ------------------------------------------------------------------ */

function LegacyQuestionPrompt({
  question,
  onRespond,
}: {
  question: QuestionRequest;
  onRespond: (answer: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [answer, setAnswer] = useState("");
  const isMobile = isRemoteMode();

  const questionText =
    (question.arguments?.question as string) ||
    (question.arguments?.questions as string) ||
    t("agentQuestion");

  const options = normalizeLegacyOptions(question.arguments?.options);

  const handleSubmit = () => {
    if (!answer.trim()) return;
    onRespond(answer);
    setAnswer("");
  };

  return (
    <div className={isMobile ? "px-3 pb-[max(env(safe-area-inset-bottom),8px)]" : "px-4 pb-3"}>
      <div className={isMobile ? "" : "mx-auto max-w-[736px]"}>
        <div className={`rounded-${isMobile ? "2xl" : "xl"} border-2 border-[var(--brand-primary)]/40 bg-${isMobile ? "[var(--surface-primary)] shadow-lg" : "[var(--brand-primary)]/5"} p-4 animate-slide-up`}>
          <div className="flex items-start gap-3">
            <HelpCircle className="h-5 w-5 text-[var(--brand-primary)] shrink-0 mt-0.5" />
            <div className="flex-1 space-y-3">
              <div>
                <h3 className={`${isMobile ? "text-base" : "text-sm"} font-semibold text-[var(--text-primary)]`}>
                  {t("agentAsking")}
                </h3>
                <div className={`${isMobile ? "text-base" : "text-sm"} text-[var(--text-secondary)] mt-1 prose prose-sm prose-invert max-w-none [&>p]:m-0`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {questionText}
                  </ReactMarkdown>
                </div>
              </div>

              {options.length > 0 && (
                <div className="space-y-2">
                  {options.map((opt, i) => (
                    <button
                      key={`${opt.label}-${i}`}
                      onClick={() => onRespond(opt.label)}
                      className={`w-full text-left rounded-${isMobile ? "xl" : "lg"} border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 ${isMobile ? "py-3 min-h-[48px]" : "py-2"} text-sm hover:bg-[var(--surface-tertiary)] active:scale-[0.98] transition-all`}
                    >
                      <span className="font-medium text-[var(--text-primary)]">
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="block text-xs text-[var(--text-tertiary)] mt-0.5">
                          {opt.description}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <input
                  type="text"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                  placeholder={t("typeAnswer")}
                  className={`flex-1 rounded-${isMobile ? "xl" : "lg"} border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 ${isMobile ? "py-3 text-base" : "py-2 text-sm"} outline-none focus:ring-1 focus:ring-[var(--ring)]`}
                />
                <Button
                  size={isMobile ? "default" : "sm"}
                  onClick={handleSubmit}
                  disabled={!answer.trim()}
                  className={`gap-1.5 ${isMobile ? "h-12 px-4" : ""}`}
                >
                  <Send className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
                  {t("submit")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Multi-question Tab UI (Desktop)                                    */
/* ------------------------------------------------------------------ */

const OTHER_SENTINEL = "__other__";

function MultiQuestionPrompt({
  questions,
  onRespond,
}: {
  questions: QuestionItem[];
  onRespond: (answers: Record<string, string>) => void;
}) {
  const { t } = useTranslation("chat");
  const isMobile = isRemoteMode();
  const [activeTab, setActiveTab] = useState(0);
  // Single-select stores string, multi-select stores string[]
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({});

  const currentQ = questions[activeTab];
  const hasPreview = currentQ?.options?.some((o) => o.preview);

  // Check if all questions are answered
  const allAnswered = questions.every((q) => {
    const val = answers[q.question];
    if (val === undefined || val === null) return false;
    if (Array.isArray(val)) return val.length > 0;
    if (val === OTHER_SENTINEL) return !!otherTexts[q.question]?.trim();
    return !!val;
  });

  // Get selected option's preview content
  const selectedValue = answers[currentQ?.question];
  const selectedLabel = Array.isArray(selectedValue) ? selectedValue[0] : selectedValue;
  const selectedPreview =
    selectedLabel && selectedLabel !== OTHER_SENTINEL
      ? currentQ?.options?.find((o) => o.label === selectedLabel)?.preview
      : undefined;

  // Set answer for a question (single-select)
  const setAnswer = useCallback((questionText: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionText]: value }));
  }, []);

  // Toggle answer for a question (multi-select)
  const toggleAnswer = useCallback((questionText: string, value: string) => {
    setAnswers((prev) => {
      const current = (prev[questionText] as string[]) || [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      return { ...prev, [questionText]: next };
    });
  }, []);

  // Handle submit
  const handleSubmit = useCallback(() => {
    if (!allAnswered) return;
    const result: Record<string, string> = {};
    for (const q of questions) {
      const val = answers[q.question];
      if (val === OTHER_SENTINEL) {
        result[q.question] = otherTexts[q.question]?.trim() || "";
      } else if (Array.isArray(val)) {
        // For multi-select, replace OTHER_SENTINEL with actual text
        const resolved = val.map((v) =>
          v === OTHER_SENTINEL ? otherTexts[q.question]?.trim() || "" : v
        );
        result[q.question] = resolved.filter(Boolean).join(", ");
      } else {
        result[q.question] = val || "";
      }
    }
    onRespond(result);
  }, [allAnswered, answers, otherTexts, questions, onRespond]);

  // Keyboard: Esc to cancel, left/right to switch tabs, number keys for submit
  useEffect(() => {
    if (isMobile) return; // Skip keyboard handlers on mobile
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onRespond({ __cancelled__: "true" });
        return;
      }
      if (e.key === "ArrowLeft") {
        setActiveTab((prev) => Math.max(0, prev - 1));
        return;
      }
      if (e.key === "ArrowRight") {
        setActiveTab((prev) => Math.min(questions.length - 1, prev + 1));
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [questions.length, onRespond, isMobile]);

  // Mobile: accordion/stepper layout
  if (isMobile) {
    return (
      <div className="px-3 pb-[max(env(safe-area-inset-bottom),8px)]">
        <div className="rounded-2xl border-2 border-[var(--brand-primary)]/40 bg-[var(--surface-primary)] shadow-lg animate-slide-up overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
            <div className="flex items-center gap-2">
              <HelpCircle className="h-5 w-5 text-[var(--brand-primary)]" />
              <span className="text-base font-semibold text-[var(--text-primary)]">
                {questions.length} questions
              </span>
            </div>
            <button
              onClick={() => onRespond({ __cancelled__: "true" })}
              className="px-3 py-1.5 text-sm text-[var(--text-tertiary)] active:text-[var(--text-primary)]"
            >
              Cancel
            </button>
          </div>

          {/* Accordion questions */}
          <div className="max-h-[60vh] overflow-y-auto">
            {questions.map((q, i) => {
              const isActive = i === activeTab;
              const isAnswered = (() => {
                const val = answers[q.question];
                if (val === undefined || val === null) return false;
                if (Array.isArray(val)) return val.length > 0;
                if (val === OTHER_SENTINEL) return !!otherTexts[q.question]?.trim();
                return !!val;
              })();

              return (
                <div key={i} className="border-b border-[var(--border-default)] last:border-b-0">
                  {/* Accordion header */}
                  <button
                    onClick={() => setActiveTab(isActive ? -1 : i)}
                    className="w-full flex items-center justify-between px-4 py-3 active:bg-[var(--surface-secondary)] transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`h-6 w-6 rounded-full text-xs font-semibold flex items-center justify-center shrink-0 ${
                        isAnswered
                          ? "bg-[var(--color-success)] text-white"
                          : "bg-[var(--surface-secondary)] text-[var(--text-tertiary)]"
                      }`}>
                        {isAnswered ? "\u2713" : i + 1}
                      </span>
                      <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {q.header}
                      </span>
                    </div>
                    {isActive
                      ? <ChevronUp className="h-4 w-4 text-[var(--text-tertiary)] shrink-0" />
                      : <ChevronDown className="h-4 w-4 text-[var(--text-tertiary)] shrink-0" />}
                  </button>

                  {/* Accordion body */}
                  {isActive && (
                    <div className="px-4 pb-4">
                      <div className="text-sm font-medium text-[var(--text-primary)] mb-3">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {q.question}
                        </ReactMarkdown>
                      </div>

                      <div className="space-y-2">
                        {q.options?.map((opt, optIdx) => (
                          <OptionRow
                            key={`${opt.label}-${optIdx}`}
                            option={opt}
                            questionText={q.question}
                            multiSelect={!!q.multiSelect}
                            selected={
                              q.multiSelect
                                ? ((answers[q.question] as string[]) || []).includes(opt.label)
                                : answers[q.question] === opt.label
                            }
                            onSelect={() => {
                              if (q.multiSelect) {
                                toggleAnswer(q.question, opt.label);
                              } else {
                                setAnswer(q.question, opt.label);
                              }
                            }}
                            isMobile
                          />
                        ))}

                        <OtherOption
                          questionText={q.question}
                          multiSelect={!!q.multiSelect}
                          selected={
                            q.multiSelect
                              ? ((answers[q.question] as string[]) || []).includes(OTHER_SENTINEL)
                              : answers[q.question] === OTHER_SENTINEL
                          }
                          otherText={otherTexts[q.question] || ""}
                          onSelect={() => {
                            if (q.multiSelect) {
                              toggleAnswer(q.question, OTHER_SENTINEL);
                            } else {
                              setAnswer(q.question, OTHER_SENTINEL);
                            }
                          }}
                          onTextChange={(text) =>
                            setOtherTexts((prev) => ({ ...prev, [q.question]: text }))
                          }
                          isMobile
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Submit bar */}
          <div className="px-4 py-3 border-t border-[var(--border-default)]">
            <button
              onClick={handleSubmit}
              disabled={!allAnswered}
              className="w-full h-12 flex items-center justify-center gap-2 rounded-xl bg-[var(--text-primary)] text-[var(--surface-primary)] text-base font-medium active:scale-[0.97] transition-all disabled:opacity-30"
            >
              <Send className="h-4 w-4" />
              {t("questionSubmitAll", "Submit answers")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Desktop: Tab + preview panel layout (unchanged)
  return (
    <div className="px-4 pb-3">
      <div className="mx-auto max-w-[736px]">
        <div className="rounded-xl border-2 border-[var(--brand-primary)]/40 bg-[var(--brand-primary)]/5 animate-slide-up overflow-hidden">
          {/* Tab bar */}
          <div
            className="flex border-b border-[var(--border-default)]"
            role="tablist"
          >
            {questions.map((q, i) => {
              const isActive = i === activeTab;
              const isAnswered = (() => {
                const val = answers[q.question];
                if (val === undefined || val === null) return false;
                if (Array.isArray(val)) return val.length > 0;
                if (val === OTHER_SENTINEL) return !!otherTexts[q.question]?.trim();
                return !!val;
              })();
              return (
                <button
                  key={i}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(i)}
                  className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                    isActive
                      ? "text-[var(--text-primary)] border-b-2 border-[var(--brand-primary)]"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  {q.header}
                  {isAnswered && (
                    <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-success)]" />
                  )}
                </button>
              );
            })}
            {/* Close button */}
            <button
              onClick={() => onRespond({ __cancelled__: "true" })}
              className="ml-auto px-3 py-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
              aria-label="Close"
            >
              &times;
            </button>
          </div>

          {/* Tab content */}
          <div className="p-4" role="tabpanel">
            {/* Question text */}
            <div className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {currentQ.question}
              </ReactMarkdown>
            </div>

            <div className={`flex gap-4 ${hasPreview ? "" : ""}`}>
              {/* Options */}
              <div className={`space-y-1.5 ${hasPreview ? "flex-1" : "w-full"}`}>
                {currentQ.options?.map((opt, i) => (
                  <OptionRow
                    key={`${opt.label}-${i}`}
                    option={opt}
                    questionText={currentQ.question}
                    multiSelect={!!currentQ.multiSelect}
                    selected={
                      currentQ.multiSelect
                        ? ((answers[currentQ.question] as string[]) || []).includes(opt.label)
                        : answers[currentQ.question] === opt.label
                    }
                    onSelect={() => {
                      if (currentQ.multiSelect) {
                        toggleAnswer(currentQ.question, opt.label);
                      } else {
                        setAnswer(currentQ.question, opt.label);
                      }
                    }}
                  />
                ))}

                {/* Other option */}
                <OtherOption
                  questionText={currentQ.question}
                  multiSelect={!!currentQ.multiSelect}
                  selected={
                    currentQ.multiSelect
                      ? ((answers[currentQ.question] as string[]) || []).includes(OTHER_SENTINEL)
                      : answers[currentQ.question] === OTHER_SENTINEL
                  }
                  otherText={otherTexts[currentQ.question] || ""}
                  onSelect={() => {
                    if (currentQ.multiSelect) {
                      toggleAnswer(currentQ.question, OTHER_SENTINEL);
                    } else {
                      setAnswer(currentQ.question, OTHER_SENTINEL);
                    }
                  }}
                  onTextChange={(text) =>
                    setOtherTexts((prev) => ({ ...prev, [currentQ.question]: text }))
                  }
                />
              </div>

              {/* Preview panel */}
              {hasPreview && (
                <div className="flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3 max-h-64 overflow-y-auto">
                  {selectedPreview ? (
                    <div className="text-sm text-[var(--text-secondary)] prose prose-sm prose-invert max-w-none [&>p]:m-0 font-mono">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {selectedPreview}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div className="text-sm text-[var(--text-tertiary)] italic">
                      {t("questionPreviewPlaceholder", "Select an option to see preview")}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Bottom bar */}
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-[var(--border-default)]">
            <span className="text-xs text-[var(--text-tertiary)]">
              {t("questionEscCancel", "Esc to cancel")}
            </span>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!allAnswered}
              className="gap-1.5"
            >
              <Send className="h-3.5 w-3.5" />
              {t("questionSubmitAll", "Submit answers")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Option row (radio / checkbox)                                      */
/* ------------------------------------------------------------------ */

function OptionRow({
  option,
  questionText,
  multiSelect,
  selected,
  onSelect,
  isMobile,
}: {
  option: QuestionOptionItem;
  questionText: string;
  multiSelect: boolean;
  selected: boolean;
  onSelect: () => void;
  isMobile?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 cursor-pointer rounded-${isMobile ? "xl" : "lg"} border px-3 ${isMobile ? "py-3 min-h-[48px]" : "py-2"} text-sm transition-all active:scale-[0.98] ${
        selected
          ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/10"
          : "border-[var(--border-default)] bg-[var(--surface-secondary)] hover:bg-[var(--surface-tertiary)]"
      }`}
    >
      <input
        type={multiSelect ? "checkbox" : "radio"}
        name={`q-${questionText}`}
        value={option.label}
        checked={selected}
        onChange={onSelect}
        className={`${isMobile ? "mt-1 h-5 w-5" : "mt-0.5"} accent-[var(--brand-primary)]`}
      />
      <div className="flex-1 min-w-0">
        <span className="font-medium text-[var(--text-primary)]">
          {option.label}
        </span>
        {option.description && (
          <span className="block text-xs text-[var(--text-tertiary)] mt-0.5">
            {option.description}
          </span>
        )}
      </div>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/*  "Other" option with text input                                     */
/* ------------------------------------------------------------------ */

function OtherOption({
  questionText,
  multiSelect,
  selected,
  otherText,
  onSelect,
  onTextChange,
  isMobile,
}: {
  questionText: string;
  multiSelect: boolean;
  selected: boolean;
  otherText: string;
  onSelect: () => void;
  onTextChange: (text: string) => void;
  isMobile?: boolean;
}) {
  const { t } = useTranslation("chat");

  return (
    <div>
      <label
        className={`flex items-start gap-3 cursor-pointer rounded-${isMobile ? "xl" : "lg"} border px-3 ${isMobile ? "py-3 min-h-[48px]" : "py-2"} text-sm transition-all active:scale-[0.98] ${
          selected
            ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/10"
            : "border-[var(--border-default)] bg-[var(--surface-secondary)] hover:bg-[var(--surface-tertiary)]"
        }`}
      >
        <input
          type={multiSelect ? "checkbox" : "radio"}
          name={`q-${questionText}`}
          value={OTHER_SENTINEL}
          checked={selected}
          onChange={onSelect}
          className={`${isMobile ? "mt-1 h-5 w-5" : "mt-0.5"} accent-[var(--brand-primary)]`}
        />
        <span className="font-medium text-[var(--text-primary)]">
          {t("questionOther", "Other")}
        </span>
      </label>
      {selected && (
        <input
          type="text"
          value={otherText}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={t("questionOtherPlaceholder", "Type your answer...")}
          className={`mt-1.5 w-full rounded-${isMobile ? "xl" : "lg"} border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 ${isMobile ? "py-3 text-base" : "py-2 text-sm"} outline-none focus:ring-1 focus:ring-[var(--ring)]`}
          autoFocus
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Top-level export: auto-detects mode                                */
/* ------------------------------------------------------------------ */

export function QuestionPrompt({ question, onRespond }: QuestionPromptProps) {
  const rawQuestions = question.arguments?.questions;
  const isMultiMode =
    Array.isArray(rawQuestions) && rawQuestions.length > 0;

  if (isMultiMode) {
    return (
      <MultiQuestionPrompt
        questions={rawQuestions as QuestionItem[]}
        onRespond={onRespond}
      />
    );
  }

  return <LegacyQuestionPrompt question={question} onRespond={onRespond as (answer: string) => void} />;
}
