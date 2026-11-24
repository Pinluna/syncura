/* Call history, shown in the chat.

   Three outcomes, three colours, three icons -- the icon carries the meaning for
   anyone who cannot rely on the colour, and the colour makes the list scannable
   without reading it:

     red    missed   rang and was not answered
     green  received answered
     blue   dialed   placed from this phone

   Each row is timestamped with the time the call was placed, which is the moment
   that identifies it; a call spanning midnight belongs to the day it started. */

import { ArrowDownLeft, PhoneMissed, Video, VideoOff } from "lucide-react";
import type { CallRecord } from "../lib/api";

/**
 * The wall-clock time the call was placed, in the phone's own timezone.
 *
 * Intl rather than a hand-rolled format so it matches the rest of the app and
 * respects whatever the phone is set to, including 12- vs 24-hour.
 */
export function callTime(record: CallRecord): string {
  const date = new Date(record.startedAt);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

/** "Today 14:32" for today, otherwise the date too. Older than a week gets no year. */
export function callDayLabel(record: CallRecord): string {
  const date = new Date(record.startedAt);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const started = date.getTime();
  if (started >= startOfToday) return "Today";
  const yesterday = startOfToday - 86_400_000;
  if (started >= yesterday) return "Yesterday";
  const withinWeek = new Date(now.getTime() - 6 * 86_400_000);
  if (date >= new Date(withinWeek.getFullYear(), withinWeek.getMonth(), withinWeek.getDate())) {
    return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" }).format(date);
}

/** How long the call ran, but only when it is worth showing. */
export function callDuration(record: CallRecord): string {
  if (!record.connectedAt) return "";
  const seconds = Math.round(
    (new Date(record.endedAt).getTime() - new Date(record.connectedAt).getTime()) / 1000,
  );
  if (!Number.isFinite(seconds) || seconds < 1) return "";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}:${String(rest).padStart(2, "0")}` : `${rest}s`;
}

function CallIcon({ record }: { record: CallRecord }) {
  if (record.outcome === "missed") return <PhoneMissed aria-hidden="true" />;
  if (record.outcome === "dialed") return <ArrowDownLeft aria-hidden="true" />;
  return record.mode === "video"
    ? <Video aria-hidden="true" />
    : <VideoOff aria-hidden="true" />;
}

function outcomeLabel(record: CallRecord): string {
  if (record.outcome === "missed") return "Missed call";
  if (record.outcome === "dialed") return record.mode === "video" ? "Video call" : "Call";
  return record.mode === "video" ? "Answered video call" : "Answered call";
}

export function CallLog({ calls }: { calls: CallRecord[] }) {
  if (!calls.length) return null;

  /* Newest first, and stable within a second or two -- ties broken by the row id
     so the list does not shuffle between two calls placed in the same moment. */
  const ordered = [...calls].sort((a, b) => {
    const byTime = new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
  });

  let lastDay = "";

  return (
    <div className="call-log" role="list" aria-label="Call history">
      {ordered.map((record) => {
        const day = callDayLabel(record);
        const showDay = day && day !== lastDay;
        if (showDay) lastDay = day;
        const duration = callDuration(record);
        return (
          <div key={record.id}>
            {showDay && <div className="call-log-day">{day}</div>}
            <div
              className="call-log-row"
              data-outcome={record.outcome}
              role="listitem"
              aria-label={`${outcomeLabel(record)} at ${callTime(record)}${duration ? `, ${duration}` : ""}`}
            >
              <span className="call-log-icon">
                <CallIcon record={record} />
              </span>
              <span className="call-log-text">
                <span className="call-log-label">{outcomeLabel(record)}</span>
                {duration && <span className="call-log-duration">{duration}</span>}
              </span>
              <time className="call-log-time" dateTime={record.startedAt}>
                {callTime(record)}
              </time>
            </div>
          </div>
        );
      })}
    </div>
  );
}