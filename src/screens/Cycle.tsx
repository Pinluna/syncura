import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { api, type CycleSettings } from "../lib/api";
import { Card } from "../components/ui";
import { useSession } from "../lib/session";
import { CycleCalendar, CycleSummary, HormoneChart, type SeriesKey } from "../components/Charts";
import { CycleRing } from "../components/Gauges";
import {
  dayKind,
  getCycleInfo,
  hormoneCurve,
  isCycleConfigured,
  isUnsafeAfterOvulation,
  PERIOD_LENGTHS,
  todayKey,
  parseKey,
} from "../lib/cycle";
import type { PeriodFlow } from "../lib/api";
import { useToast } from "../components/ToastProvider";

const FALLBACK: CycleSettings = {
  cycleLength: 28,
  periodLength: 5,
  lastPeriodStart: null,
  lastPeriodEnd: null,
  periodDays: [],
  periodFlow: {},
  /* Nothing is assumed before she has picked her own numbers. */
  cycleConfigured: false,
  ignoredDates: [],
  shareLocation: false,
  shareActivity: true,
  shareBattery: true,
  shareJournal: false,
  liveSharing: false,
};

const ACTIVE_ALL: Record<SeriesKey, boolean> = {
  estradiol: true,
  progesterone: true,
  lh: true,
  fsh: true,
};

export default function Cycle() {
  const { me, updateMe } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const [month, setMonth] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [savingDay, setSavingDay] = useState<string | null>(null);
  const [savingPrediction, setSavingPrediction] = useState(false);
  const [flow, setFlow] = useState<PeriodFlow>("medium");
  const [savingPeriodLength, setSavingPeriodLength] = useState(false);
  const [savingIntimacy, setSavingIntimacy] = useState(false);
  const [active, setActive] = useState<Record<SeriesKey, boolean>>(ACTIVE_ALL);

  const cfg = dashboard.data?.settings ?? me?.settings ?? FALLBACK;
  const info = getCycleInfo(cfg, todayKey());
  const curve = hormoneCurve(info?.cycleLength ?? cfg.cycleLength);
  const ovulationDay = info
    ? Math.max(1, parseKey(info.ovulationDate) - parseKey(info.nextPeriod) + info.cycleLength)
    : Math.max(1, cfg.cycleLength - 14);

  const toggle = (key: SeriesKey) => setActive((a) => ({ ...a, [key]: !a[key] }));
  const canLogPeriod = me?.user.sex === "female";
  const logDate = selectedDay ?? todayKey();
  const intimacyCounts = Object.fromEntries(
    (dashboard.data?.logs ?? [])
      .filter((log) => log.intercourseCount > 0)
      .map((log) => [log.logDate, log.intercourseCount]),
  );
  const selectedIsPeriod = Boolean(selectedDay && (cfg.periodDays ?? []).includes(selectedDay));
  const intimacyCount = intimacyCounts[logDate] ?? 0;

  const selectedFlow = selectedDay ? cfg.periodFlow?.[selectedDay] : undefined;
  useEffect(() => {
    setFlow(selectedFlow ?? "medium");
  }, [selectedDay, selectedFlow]);

  /* A date carrying a prediction the app worked out for itself, as opposed to
     one she actually logged. Only hers, only days that have not passed. A date
     she has already dismissed reads as an ordinary day, and offers itself back
     so the removal is never a one-way door. */
  const selectedIsRemoved = Boolean(
    selectedDay && canLogPeriod && (cfg.ignoredDates ?? []).includes(selectedDay),
  );
  const selectedIsPrediction = Boolean(
    selectedDay &&
      canLogPeriod &&
      !selectedIsRemoved &&
      isCycleConfigured(cfg) &&
      !(cfg.periodDays ?? []).includes(selectedDay) &&
      selectedDay <= todayKey() &&
      (dayKind(selectedDay, cfg) !== null || isUnsafeAfterOvulation(selectedDay, cfg)),
  );

  const togglePrediction = async (remove: boolean) => {
    if (!selectedDay || savingPrediction) return;
    setSavingPrediction(true);
    try {
      const updated = await api.removePrediction(selectedDay, remove);
      qc.setQueryData(["me"], updated);
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(remove ? "Prediction removed" : "Prediction restored");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update this prediction");
    } finally {
      setSavingPrediction(false);
    }
  };

  const togglePeriodDay = async (logDate: string, logged: boolean) => {
    if (!canLogPeriod || logDate > todayKey() || savingDay) return;
    setSavingDay(logDate);
    try {
      const updated = await api.setPeriodDay(logDate, logged, flow);
      qc.setQueryData(["me"], updated);
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(logged ? "Period day logged" : "Period day removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save this period day");
    } finally {
      setSavingDay(null);
    }
  };

  const savePeriodLength = async (value: string) => {
    const periodLength = Number(value);
    if (savingPeriodLength || !PERIOD_LENGTHS.includes(periodLength)) return;
    setSavingPeriodLength(true);
    try {
      await updateMe({ periodLength });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["dashboard"] }),
        qc.invalidateQueries({ queryKey: ["me"] }),
      ]);
      toast.success("Predicted period length updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update period length");
    } finally {
      setSavingPeriodLength(false);
    }
  };

  const logIntimacy = async (delta: -1 | 1) => {
    if (!canLogPeriod || logDate > todayKey() || savingIntimacy) return;
    const nextCount = Math.max(0, Math.min(20, intimacyCount + delta));
    if (nextCount === intimacyCount) return;
    setSavingIntimacy(true);
    try {
      await api.log({ logDate, intercourseCount: nextCount });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(delta > 0 ? "Intimacy logged" : "Intimacy log updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save intimacy log");
    } finally {
      setSavingIntimacy(false);
    }
  };

  return (
    <div className="stack">
      <div className="pageTop">
        <h1>Cycle</h1>
        <span className="sub">Predictions, hormones and calendar view.</span>
      </div>
      <Card title="Overview" icon="chart">
        {info && (
          <CycleRing
            cycleDay={info.cycleDay}
            cycleLength={info.cycleLength}
            periodLength={info.periodLength}
            phase={info.phase}
          />
        )}
        <CycleSummary info={info} />
      </Card>
      <Card title="Hormone levels" icon="flame">
        <HormoneChart data={curve} ovulationDay={ovulationDay} active={active} onToggle={toggle} />
      </Card>
      <Card title="Calendar" icon="calendar">
        <div className="stack">
          {!isCycleConfigured(cfg) && (
            <span className="sub">
              Your cycle is not set up yet, so nothing is predicted here. Choose your cycle length, period length and
              last period start in <strong>Settings</strong> to fill this calendar in.
            </span>
          )}
          <CycleCalendar
            month={month}
            cfg={cfg}
            onMonth={setMonth}
            selectedDay={selectedDay}
            onSelectDay={setSelectedDay}
            canLogPeriod={canLogPeriod}
            intimacyCounts={intimacyCounts}
          />
          <label className="field">
            <span className="fieldLabel">Predicted period length</span>
            <select
              className="select"
              value={cfg.periodLength}
              disabled={!canLogPeriod || savingPeriodLength}
              onChange={(event) => void savePeriodLength(event.target.value)}
            >
              {PERIOD_LENGTHS.map((days) => <option key={days} value={days}>{days} days</option>)}
            </select>
          </label>
          <span className="sub">
            {savingDay
              ? `Saving ${savingDay}…`
              : canLogPeriod
                ? selectedDay
                  ? `Selected ${selectedDay}. Record the flow for an actual period day; predicted dates remain estimates.`
                  : "Select a date to log an actual period day."
                : "Period days are shared here; only your female partner can log them."}
          </span>
          {selectedIsPrediction && (
            <div className="row">
              <span className="fine grow">
                {selectedDay} is a prediction, not something you logged. Remove it and everything around it is worked out
                again.
              </span>
              <button
                type="button"
                className="btn outline sm"
                disabled={savingPrediction}
                onClick={() => void togglePrediction(true)}
              >
                {savingPrediction ? "Removing…" : "Remove prediction"}
              </button>
            </div>
          )}
          {selectedIsRemoved && (
            <div className="row">
              <span className="fine grow">{selectedDay} is no longer predicted.</span>
              <button
                type="button"
                className="btn ghost sm"
                disabled={savingPrediction}
                onClick={() => void togglePrediction(false)}
              >
                {savingPrediction ? "Restoring…" : "Put it back"}
              </button>
            </div>
          )}
          {canLogPeriod && selectedDay && selectedDay <= todayKey() && !selectedIsPrediction && (
            <div className="row">
              <label className="field grow">
                <span className="fieldLabel">Flow</span>
                <select className="select" value={flow} onChange={(event) => setFlow(event.target.value as PeriodFlow)}>
                  <option value="light">Light</option>
                  <option value="medium">Medium</option>
                  <option value="heavy">Heavy</option>
                </select>
              </label>
              <button
                type="button"
                className={`btn ${selectedIsPeriod ? "secondary" : "primary"} sm`}
                disabled={Boolean(savingDay)}
                onClick={() => void togglePeriodDay(selectedDay, true)}
              >
                {savingDay ? "Saving…" : selectedIsPeriod ? "Update flow" : "Log period"}
              </button>
              {selectedIsPeriod && (
                <button
                  type="button"
                  className="btn outline sm"
                  disabled={Boolean(savingDay)}
                  onClick={() => void togglePeriodDay(selectedDay, false)}
                >
                  Remove
                </button>
              )}
            </div>
          )}
          <div className="intimacy-log">
            <div className="row">
              <div className="grow">
                <strong>Intimacy log</strong>
                <span className="sub" style={{ display: "block" }}>{logDate}</span>
              </div>
              <span className="intimacy-count" aria-label={`${intimacyCount} times`}>
                {intimacyCount > 0 ? "♥".repeat(intimacyCount) : "No entries"}
              </span>
            </div>
            {canLogPeriod ? (
              <div className="row">
                <button
                  type="button"
                  className="btn outline sm"
                  aria-label="Remove one intimacy entry"
                  disabled={intimacyCount === 0 || savingIntimacy || logDate > todayKey()}
                  onClick={() => void logIntimacy(-1)}
                >
                  −
                </button>
                <button
                  type="button"
                  className="btn outline sm"
                  disabled={intimacyCount >= 20 || savingIntimacy || logDate > todayKey()}
                  onClick={() => void logIntimacy(1)}
                >
                  {savingIntimacy ? "Saving…" : "Log intimacy"}
                </button>
              </div>
            ) : (
              <span className="fine">Intimacy counts are shared; only your female partner can log them.</span>
            )}
          </div>
          <span className="fine">Dotted dates are predictions. Logged flow is shown from pale pink to deep red; small hearts show intimacy counts.</span>
        </div>
      </Card>
      <span className="fine">Predictions are informative only and not a substitute for contraception or medical advice.</span>
    </div>
  );
}

