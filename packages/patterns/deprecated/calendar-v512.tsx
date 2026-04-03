/// <cts-enable />
import {
  Default,
  derive,
  handler,
  ifElse,
  lift,
  NAME,
  pattern,
  str,
  Stream,
  UI,
  Writable,
} from "commontools";

interface Note {
  id: string;
  text: string;
  scheduledTime?: string; // Start time in HH:MM format
  duration?: string; // Duration in minutes (e.g., '60', '90', '120') or 'none'
  notificationEnabled?: boolean;
  notificationValue?: number; // Default 1
  notificationUnit?: "minute" | "hour" | "day" | "week"; // Default 'minute'
  seriesId?: string; // If present, this is a recurring event occurrence
}

interface RecurringSeries {
  seriesId: string;
  parentSeriesId?: string; // ID of the series this was split from (for lineage tracking)
  text: string;
  rrule: string; // Format: "FREQ=DAILY" or "FREQ=WEEKLY;BYDAY=MO,WE,FR"
  dtstart: string; // ISO date "2025-11-12"
  scheduledTime?: string;
  duration?: string;
  notificationEnabled?: boolean;
  notificationValue?: number;
  notificationUnit?: "minute" | "hour" | "day" | "week";
  until?: string; // ISO date - series ends on/before this
  count?: number; // Alternative to until - max occurrences
}

interface SeriesOverride {
  seriesId: string;
  recurrenceDate: string; // ISO date of the occurrence being modified
  canceled?: boolean;
  deleted?: boolean; // Mark occurrence as deleted
  text?: string;
  scheduledTime?: string;
  duration?: string;
  notificationEnabled?: boolean;
  notificationValue?: number;
  notificationUnit?: "minute" | "hour" | "day" | "week";
}

interface DayEntry {
  date: string; // ISO date string (YYYY-MM-DD)
  notes: Default<Note[], []>;
}

interface TimeLabel {
  label: string; // e.g., "Morning", "Afternoon", "Evening"
  time: string; // 24-hour format e.g., "09:00"
}

interface Input {
  entries: Default<DayEntry[], []>;
  recurringSeries: Default<RecurringSeries[], []>;
  seriesOverrides: Default<SeriesOverride[], []>;
  name: Default<string, "calendar-v512">;
  customTimeLabels: Default<
    TimeLabel[],
    [{ label: "Morning"; time: "09:00" }, { label: "Evening"; time: "18:00" }]
  >;
  startTime: Default<number, 7>; // Start hour in 24-hour format (7 = 7 AM)
  endTime: Default<number, 19>; // End hour in 24-hour format (19 = 7 PM)
  timeInterval: Default<30 | 60, 60>; // Time slot interval in minutes
  showMonthView: Default<boolean, true>; // Show/hide month calendar view
}

interface Output {
  entries: DayEntry[];
  currentDate: string;
  name: string;
  customTimeLabels: TimeLabel[];
  addEntry: Stream<{ date: string; text: string }>;
  updateEntry: Stream<{ date: string; noteId: string; text: string }>;
  goToDate: Stream<{ date: string }>;
  rename: Stream<{ name: string }>;

  // Field setters
  setScheduledTime: Stream<
    { date: string; noteId: string; scheduledTime?: string }
  >;
  setDuration: Stream<{ date: string; noteId: string; duration?: string }>;
  setNotification: Stream<
    {
      date: string;
      noteId: string;
      enabled: boolean;
      value?: number;
      unit?: "minute" | "hour" | "day" | "week";
    }
  >;

  // Series management
  createSeries: Stream<
    {
      text: string;
      rrule: string;
      dtstart: string;
      scheduledTime?: string;
      duration?: string;
      notificationEnabled?: boolean;
      notificationValue?: number;
      notificationUnit?: "minute" | "hour" | "day" | "week";
      until?: string;
      count?: number;
    }
  >;
  updateSeries: Stream<
    {
      seriesId: string;
      text?: string;
      rrule?: string;
      scheduledTime?: string;
      duration?: string;
      notificationEnabled?: boolean;
      notificationValue?: number;
      notificationUnit?: "minute" | "hour" | "day" | "week";
      until?: string;
      count?: number;
    }
  >;
  deleteSeries: Stream<{ seriesId: string }>;
}

// Format time in AM/PM format - base function
const formatTimeAMPM = (hour: number, minute: number): string => {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const minuteStr = String(minute).padStart(2, "0");
  return `${displayHour}:${minuteStr} ${period}`;
};

// OPTIMIZATION v10: Pre-computed AM/PM format cache for O(1) lookup
const formatTimeAMPMCache = (() => {
  const cache = new Map<number, Map<number, string>>();
  for (let h = 0; h < 24; h++) {
    const hourCache = new Map<number, string>();
    const period = h >= 12 ? "PM" : "AM";
    const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
    for (let m = 0; m < 60; m++) {
      const minuteStr = String(m).padStart(2, "0");
      hourCache.set(m, `${displayHour}:${minuteStr} ${period}`);
    }
    cache.set(h, hourCache);
  }
  return (hour: number, minute: number): string => {
    return cache.get(hour)?.get(minute) ?? formatTimeAMPM(hour, minute);
  };
})();

// OPTIMIZATION v10: Pre-computed time slot structure
interface TimeSlot {
  timeStr: string;
  hour: number;
  minute: number;
  displayTime: string;
  order: number;
  minutesOffset: number;
}

// OPTIMIZATION v13: ISO date formatter utility (reduces repeated padStart calls)
const _formatISO = (year: number, month: number, day: number): string => {
  return `${year}-${String(month + 1).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;
};

// OPTIMIZATION v13: Parse time string utility (reduces repeated split/map)
const _parseTimeStr = (timeStr: string): { h: number; m: number } => {
  const [h, m] = timeStr.split(":").map(Number);
  return { h, m };
};

// OPTIMIZATION v507: Cached today's date (avoids new Date() in hot paths)
let _cachedToday: string | null = null;
let _cachedTodayDate: number = 0; // Store the date (day of month) to detect day changes

const getTodayISO = (): string => {
  const d = new Date();
  const currentDate = d.getDate();
  // Invalidate cache when the day changes (handles midnight correctly)
  if (!_cachedToday || currentDate !== _cachedTodayDate) {
    _cachedToday = `${d.getFullYear()}-${
      String(d.getMonth() + 1).padStart(2, "0")
    }-${String(currentDate).padStart(2, "0")}`;
    _cachedTodayDate = currentDate;
  }
  return _cachedToday;
};

// OPTIMIZATION v507: Pure formatISODate without Date objects
const formatISODate = (year: number, month: number, day: number): string => {
  return `${year}-${String(month + 1).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;
};

// OPTIMIZATION v507: Zeller's congruence - get day of week without Date object
// Returns 0=Sunday, 1=Monday, ..., 6=Saturday
const getFirstDayOfWeek = (year: number, month: number): number => {
  // Adjust for Zeller's (January=13, February=14 of previous year)
  let m = month + 1; // Convert 0-indexed to 1-indexed
  let y = year;
  if (m < 3) {
    m += 12;
    y -= 1;
  }
  const q = 1; // First day of month
  const k = y % 100;
  const j = Math.floor(y / 100);
  // Zeller's formula for Gregorian calendar
  const h = (q + Math.floor((13 * (m + 1)) / 5) + k + Math.floor(k / 4) +
    Math.floor(j / 4) - 2 * j) % 7;
  // Convert from Zeller's output (0=Saturday, 1=Sunday, 2=Monday...) to JS convention (0=Sunday)
  return ((h + 6) % 7);
};

// OPTIMIZATION v507: Get days in month without Date object
const getDaysInMonth = (year: number, month: number): number => {
  const daysPerMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 1) {
    // February - check leap year
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    return isLeap ? 29 : 28;
  }
  return daysPerMonth[month];
};

// OPTIMIZATION v507: Cache for recurring event expansion
let _recurringCache: {
  yearMonth: string;
  seriesKey: string; // Serialized key to detect content changes
  overridesKey: string; // Serialized key to detect content changes
  result: Record<string, Note[]>;
} | null = null;

// Helper to create a cache key from series/overrides that detects content changes
const getSeriesCacheKey = (series: RecurringSeries[]): string => {
  return series
    .map((s) =>
      s
        ? `${s.seriesId}:${s.dtstart}:${s.rrule}:${s.text}:${
          s.scheduledTime || ""
        }`
        : ""
    )
    .join("|");
};

const getOverridesCacheKey = (overrides: SeriesOverride[]): string => {
  return overrides
    .map((o) =>
      o
        ? `${o.seriesId}:${o.recurrenceDate}:${o.canceled || false}:${
          o.text || ""
        }:${o.scheduledTime || ""}`
        : ""
    )
    .join("|");
};

// OPTIMIZATION v508: Lookup tables for month/day names (avoid toLocaleDateString)
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// OPTIMIZATION v12: Pure JS functions for pre-computing in derivations (no lift overhead)
const computeIconForNote = (note: Note | undefined): string => {
  if (!note) return "🕐";
  if (
    note.seriesId && typeof note.seriesId === "string" && note.seriesId !== ""
  ) return "🔁";
  if (note.notificationEnabled === true) return "⏰";
  return "🕐";
};

const computeButtonClassName = (note: Note | undefined): string => {
  if (!note) return "clock-button";
  if (note.notificationEnabled === true) {
    return "clock-button clock-button-alert";
  }
  return "clock-button";
};

const computeTimeRange = (startTime: string, duration?: string): string => {
  if (!startTime) return "";

  const [startHours, startMinutes] = startTime.split(":").map(Number);
  const startPeriod = startHours >= 12 ? "PM" : "AM";
  const startHours12 = startHours % 12 || 12;

  if (!duration || duration === "none") {
    return `${startHours12}:${
      startMinutes.toString().padStart(2, "0")
    } ${startPeriod}`;
  }

  const durationMinutes = parseInt(duration, 10);
  const totalMinutes = startHours * 60 + startMinutes + durationMinutes;
  const endHours = Math.floor(totalMinutes / 60) % 24;
  const endMinutes = totalMinutes % 60;

  const endPeriod = endHours >= 12 ? "PM" : "AM";
  const endHours12 = endHours % 12 || 12;

  if (startPeriod === endPeriod) {
    return `${startHours12}:${
      startMinutes.toString().padStart(2, "0")
    }-${endHours12}:${endMinutes.toString().padStart(2, "0")} ${endPeriod}`;
  } else {
    return `${startHours12}:${
      startMinutes.toString().padStart(2, "0")
    } ${startPeriod}-${endHours12}:${
      endMinutes.toString().padStart(2, "0")
    } ${endPeriod}`;
  }
};

const buildTimeSlotGrid = (
  startTime: number,
  endTime: number,
  timeInterval: 30 | 60,
): TimeSlot[] => {
  const slots: TimeSlot[] = [];
  for (let hour = startTime; hour <= endTime; hour++) {
    const minutes = timeInterval === 60 ? [0] : [0, 30];
    for (const minute of minutes) {
      if (hour === endTime && minute > 0) continue;
      const timeStr = `${String(hour).padStart(2, "0")}:${
        String(minute).padStart(2, "0")
      }`;
      slots.push({
        timeStr,
        hour,
        minute,
        displayTime: formatTimeAMPMCache(hour, minute),
        order: hour * 100 + minute,
        minutesOffset: hour * 60 + minute,
      });
    }
  }
  return slots;
};

// Enhanced natural language parser for times, durations, and more
const parseTimeFromText = (
  text: string,
  customTimeLabels: readonly TimeLabel[] = [],
): { time: string; duration?: string; cleanedText: string } | null => {
  if (!text) return null;

  let cleanedText = text;
  let foundTime: { hour24: number; minute: number; matchText: string } | null =
    null;
  let foundDuration: number | null = null;

  // Build a map of custom time labels for quick lookup (case-insensitive)
  const timeLabelMap = new Map<string, string>();
  customTimeLabels.forEach((tl) => {
    timeLabelMap.set(tl.label.toLowerCase(), tl.time);
  });

  // Get default times for backward compatibility
  const morningTime = timeLabelMap.get("morning") || "09:00";
  const _eveningTime = timeLabelMap.get("evening") || "18:00";

  // PATTERN 0a: Meal/event keywords that imply specific times - "lunch", "breakfast", "dinner"
  // Note: We keep these words in the text since they provide context
  const mealPattern = /\b(breakfast|lunch|brunch|dinner|supper)\b/i;
  const mealMatch = text.match(mealPattern);
  if (mealMatch && !foundTime) {
    const keyword = mealMatch[1].toLowerCase();
    let hour24 = 12;
    let minute = 0;

    if (keyword === "breakfast") {
      // Use configured morning time or default to 8am
      const [h, m] = morningTime.split(":").map(Number);
      hour24 = h;
      minute = m;
    } else if (keyword === "brunch") {
      hour24 = 11; // 11 AM
    } else if (keyword === "lunch") {
      hour24 = 12; // Noon
    } else if (keyword === "dinner" || keyword === "supper") {
      hour24 = 18; // 6 PM
    }

    foundTime = { hour24, minute, matchText: mealMatch[0] };
    // Don't remove meal keywords from text - they provide context
  }

  // PATTERN 0b: Custom time labels - check all configured labels dynamically
  // Note: We keep these words in the text since they provide context
  if (!foundTime && customTimeLabels.length > 0) {
    // Build a pattern from all custom labels
    const labelPattern = new RegExp(
      `\\b(${
        customTimeLabels.map((tl) =>
          tl.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        ).join("|")
      })\\b`,
      "i",
    );
    const labelMatch = text.match(labelPattern);
    if (labelMatch) {
      const keyword = labelMatch[1].toLowerCase();
      const timeStr = timeLabelMap.get(keyword);
      if (timeStr) {
        const [h, m] = timeStr.split(":").map(Number);
        foundTime = { hour24: h, minute: m, matchText: labelMatch[0] };
        // Don't remove label from text - it provides context
      }
    }
  }

  // PATTERN 0c: Legacy hardcoded time-of-day keywords for labels not in config
  // "afternoon", "night" etc. that aren't configured
  if (!foundTime) {
    const legacyPattern = /\b(afternoon|night)\b/i;
    const legacyMatch = text.match(legacyPattern);
    if (legacyMatch) {
      const keyword = legacyMatch[1].toLowerCase();
      let hour24 = 14;
      const minute = 0;

      if (keyword === "afternoon") {
        hour24 = 14; // 2 PM
      } else if (keyword === "night") {
        hour24 = 20; // 8 PM
      }

      foundTime = { hour24, minute, matchText: legacyMatch[0] };
      // Don't remove time-of-day keywords from text - they provide context
    }
  }

  // PATTERN 1: "at TIME" - e.g., "Lunch with Joe at 2pm", "Meeting at 14:00"
  const atTimePattern = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m?|[AP]M?)?/i;
  let match = text.match(atTimePattern);
  if (match) {
    const hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    const period = match[3]?.toLowerCase() || "";

    let hour24 = hour;
    if (period.includes("p") && hour !== 12) hour24 = hour + 12;
    else if (period.includes("a") && hour === 12) hour24 = 0;
    else if (!period && hour >= 1 && hour <= 11) hour24 = hour + 12; // Default afternoon
    else if (hour >= 13) hour24 = hour; // 24-hour format

    if (hour24 >= 0 && hour24 <= 23 && minute >= 0 && minute <= 59) {
      foundTime = { hour24, minute, matchText: match[0] };
      cleanedText = cleanedText.replace(match[0], "");
    }
  }

  // PATTERN 2: Time ranges with "to", "until", "-" - e.g., "2pm to 4pm", "9-10am", "14:00 until 15:30"
  if (!foundTime) {
    const rangePatterns = [
      /(\d{1,2})(?::(\d{2}))?\s*([ap]m?)?\s*(?:to|until|[-–—])\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m?)/gi,
      /(\d{1,2})(?::(\d{2}))?\s*([ap]m?)\s*(?:to|until|[-–—])\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m?)?/gi,
    ];

    for (const pattern of rangePatterns) {
      const matches = [...text.matchAll(pattern)];
      if (matches.length > 0) {
        match = matches[0];
        const startHour = parseInt(match[1], 10);
        const startMinute = match[2] ? parseInt(match[2], 10) : 0;
        const startPeriod = match[3]?.toLowerCase() || "";
        const endHour = parseInt(match[4], 10);
        const endMinute = match[5] ? parseInt(match[5], 10) : 0;
        const endPeriod = match[6]?.toLowerCase() || "";

        const endIsPM = endPeriod.includes("p");
        const startIsPM = startPeriod.includes("p") ||
          (startPeriod === "" && endIsPM);

        let start24 = startHour;
        if (startIsPM && startHour !== 12) start24 = startHour + 12;
        else if (!startIsPM && startHour === 12) start24 = 0;

        let end24 = endHour;
        if (endIsPM && endHour !== 12) end24 = endHour + 12;
        else if (!endIsPM && endHour === 12) end24 = 0;

        if (start24 >= 0 && start24 <= 23 && end24 >= 0 && end24 <= 23) {
          foundTime = {
            hour24: start24,
            minute: startMinute,
            matchText: match[0],
          };
          const durationMins = (end24 * 60 + endMinute) -
            (start24 * 60 + startMinute);
          if (durationMins > 0) foundDuration = durationMins;
          cleanedText = cleanedText.replace(match[0], "");
        }
        break;
      }
    }
  }

  // PATTERN 3: "from TIME" - e.g., "Meeting from 3pm"
  if (!foundTime) {
    const fromPattern = /\bfrom\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m?|[AP]M?)?/i;
    match = text.match(fromPattern);
    if (match) {
      const hour = parseInt(match[1], 10);
      const minute = match[2] ? parseInt(match[2], 10) : 0;
      const period = match[3]?.toLowerCase() || "";

      let hour24 = hour;
      if (period.includes("p") && hour !== 12) hour24 = hour + 12;
      else if (period.includes("a") && hour === 12) hour24 = 0;
      else if (!period && hour >= 1 && hour <= 11) hour24 = hour + 12;

      if (hour24 >= 0 && hour24 <= 23 && minute >= 0 && minute <= 59) {
        foundTime = { hour24, minute, matchText: match[0] };
        cleanedText = cleanedText.replace(match[0], "");
      }
    }
  }

  // PATTERN 4: Standalone time - e.g., "2pm meeting", "Meeting 14:00"
  if (!foundTime) {
    const standalonePattern = /\b(\d{1,2})(?::(\d{2}))?\s*([ap]m?|[AP]M?)\b/i;
    match = text.match(standalonePattern);
    if (match) {
      const hour = parseInt(match[1], 10);
      const minute = match[2] ? parseInt(match[2], 10) : 0;
      const period = match[3]?.toLowerCase() || "";

      let hour24 = hour;
      if (period.includes("p") && hour !== 12) hour24 = hour + 12;
      else if (period.includes("a") && hour === 12) hour24 = 0;
      else if (period) hour24 = hour; // Has period marker

      if (
        hour24 >= 0 && hour24 <= 23 && minute >= 0 && minute <= 59 && period
      ) {
        foundTime = { hour24, minute, matchText: match[0] };
        cleanedText = cleanedText.replace(match[0], "");
      }
    }
  }

  // PATTERN 5: Duration phrases - supports many formats
  // "for 2 hours", "for 90 minutes", "for 1.5h", "for :30", "for 30m", "for 2:00", etc.
  if (!foundDuration) {
    const durationPatterns = [
      // Hour formats: "2 hours", "2h", "2 hr", "1.5 hours"
      /\bfor\s+(\d+(?:\.\d+)?)\s*(?:hour|hr|h)s?\b/i,
      // Minute formats: "90 minutes", "90min", "90m", "30 minutes"
      /\bfor\s+(\d+)\s*(?:minute|min|m)s?\b/i,
      // Colon format: ":30" (means 30 minutes), "2:00" (means 2 hours)
      /\bfor\s+:(\d+)\b/i,
      /\bfor\s+(\d+):(\d{2})\b/i,
      // Just number with "for": "for 30" or "for 90" (assume minutes if < 24, hours if present with context)
      /\bfor\s+(\d+)\b/i,
    ];

    for (let i = 0; i < durationPatterns.length; i++) {
      match = cleanedText.match(durationPatterns[i]);
      if (match) {
        if (i === 0) {
          // Hours
          foundDuration = Math.round(parseFloat(match[1]) * 60);
        } else if (i === 1) {
          // Minutes
          foundDuration = parseInt(match[1], 10);
        } else if (i === 2) {
          // ":30" format (minutes)
          foundDuration = parseInt(match[1], 10);
        } else if (i === 3) {
          // "2:00" format (hours:minutes)
          foundDuration = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
        } else if (i === 4) {
          // Plain number - assume minutes
          const num = parseInt(match[1], 10);
          foundDuration = num;
        }
        cleanedText = cleanedText.replace(match[0], "");
        break;
      }
    }
  }

  // Clean up extra whitespace and common words left over
  cleanedText = cleanedText
    .replace(/\s+/g, " ")
    .replace(/^\s*[-,]\s*/, "") // Leading dash or comma
    .replace(/\s*[-,]\s*$/, "") // Trailing dash or comma
    .trim();

  if (!foundTime) return null;

  return {
    time: `${foundTime.hour24.toString().padStart(2, "0")}:${
      foundTime.minute.toString().padStart(2, "0")
    }`,
    duration: foundDuration ? foundDuration.toString() : undefined,
    cleanedText,
  };
};

// Parse notification settings from text
// Returns: { enabled, value, unit, cleanedText } or null if no notification found
const parseNotifications = (
  text: string,
): {
  enabled: boolean;
  value: number;
  unit: "minute" | "hour" | "day" | "week";
  cleanedText: string;
} | null => {
  // Updated patterns to include "remember", "set an alarm", and all variations
  const notifPatterns = [
    // "set an alarm for X before" - special case
    /set\s+(?:an?\s+)?alarm\s+(?:for\s+)?(\d+)\s*(?:minute|min|m|hour|hr|h|day|d|week|w)s?\s+(?:before|early|ahead)/i,
    // Specific time before: "remind/remember me 15 minutes before", "notify 1 hour before", "don't forget 30m before"
    /(?:remind|remember|notify|don't\s+forget)(?:\s+me)?(?:\s+(?:about|to))?\s+(\d+)\s*(?:minute|min|m|hour|hr|h|day|d|week|w)s?\s+(?:before|early|ahead)/i,
    // Just time amount: "15 minute reminder", "1 hour notification", "30m alert"
    /(\d+)\s*(?:minute|min|m|hour|hr|h|day|d|week|w)s?\s+(?:reminder|notification|alert)/i,
    // Shorthand with unit: "remind 15m", "remember 1h", "notify 2d"
    /(?:remind|remember|notify|don't\s+forget)(?:\s+me)?(?:\s+(?:about|to))?\s+(\d+)\s*(m|h|d|w)\b/i,
    // Just "remind me", "remember", "don't forget", "set an alarm" - default to 0 minutes (at event time)
    /(?:remind|remember|notify|don't\s+forget|set\s+(?:an?\s+)?alarm)(?:\s+me)?(?:\s+(?:about|to))?(?!\s+\d)/i,
  ];

  let notifValue = 1;
  let notifUnit: "minute" | "hour" | "day" | "week" = "minute";
  let notifEnabled = false;
  let cleanedText = text;

  for (let i = 0; i < notifPatterns.length; i++) {
    const match = text.match(notifPatterns[i]);
    if (match) {
      notifEnabled = true;
      if (i === 4) {
        // Just "remind me", "remember", "don't forget", or "set an alarm" without time - set to 0 minutes
        notifValue = 0;
        notifUnit = "minute";
      } else {
        // Extract the number and unit
        notifValue = parseInt(match[1], 10);
        const unitStr =
          (match[2] || match[1].match(/\s*([a-z]+)s?/i)?.[1] || "m")
            .toLowerCase();

        if (unitStr.startsWith("h")) notifUnit = "hour";
        else if (unitStr.startsWith("d")) notifUnit = "day";
        else if (unitStr.startsWith("w")) notifUnit = "week";
        else notifUnit = "minute";
      }

      // Remove the notification phrase from the text
      cleanedText = text.replace(match[0], "").trim();
      break;
    }
  }

  if (!notifEnabled) return null;

  return {
    enabled: notifEnabled,
    value: notifValue,
    unit: notifUnit,
    cleanedText,
  };
};

// Parse recurrence patterns from natural language
// Returns recurrence info and cleaned text, or null if no recurrence detected
const parseRecurrencePattern = (text: string, currentDate: string): {
  frequency: "daily" | "weekly" | "monthly";
  days?: string[]; // BYDAY codes: MO, TU, WE, TH, FR, SA, SU
  monthlyPattern?: {
    type: "dayOfMonth" | "weekdayOfMonth";
    value: number;
    weekday?: string;
  };
  interval?: number; // For "every other week" = 2, "every 3 days" = 3
  cleanedText: string;
  isAmbiguous?: boolean; // True for patterns like "Monday meeting" that could be one-time or recurring
} | null => {
  if (!text) return null;

  let cleanedText = text;
  const lowerText = text.toLowerCase();

  // Day name mapping
  const dayMap: Record<string, string> = {
    "sunday": "SU",
    "sun": "SU",
    "su": "SU",
    "monday": "MO",
    "mon": "MO",
    "mo": "MO",
    "m": "MO",
    "tuesday": "TU",
    "tue": "TU",
    "tu": "TU",
    "t": "TU",
    "wednesday": "WE",
    "wed": "WE",
    "we": "WE",
    "w": "WE",
    "thursday": "TH",
    "thu": "TH",
    "th": "TH",
    "r": "TH",
    "friday": "FR",
    "fri": "FR",
    "fr": "FR",
    "f": "FR",
    "saturday": "SA",
    "sat": "SA",
    "sa": "SA",
    "s": "SA",
  };

  // PATTERN 1: "every" keyword - strong signal for recurrence
  const everyPattern = /\bevery\b/i;
  if (everyPattern.test(lowerText)) {
    // PATTERN 1a: "every other week/day" - interval patterns
    const intervalPattern =
      /\bevery\s+(other|2nd|second|third|3rd)\s+(week|day|month)/i;
    const intervalMatch = lowerText.match(intervalPattern);
    if (intervalMatch) {
      const [fullMatch, ordinal, unit] = intervalMatch;
      const interval = ordinal.match(/other|2nd|second/) ? 2 : 3;
      const freq = unit === "day"
        ? "daily"
        : unit === "week"
        ? "weekly"
        : "monthly";
      cleanedText = text.replace(new RegExp(fullMatch, "i"), "").trim();
      return { frequency: freq, interval, cleanedText };
    }

    // PATTERN 1b: "every weekday" or "every weekend"
    if (lowerText.match(/\bevery\s+week\s*days?\b/i)) {
      cleanedText = text.replace(/\bevery\s+week\s*days?\b/i, "").trim();
      return {
        frequency: "weekly",
        days: ["MO", "TU", "WE", "TH", "FR"],
        cleanedText,
      };
    }
    if (lowerText.match(/\bevery\s+weekends?\b/i)) {
      cleanedText = text.replace(/\bevery\s+weekends?\b/i, "").trim();
      return { frequency: "weekly", days: ["SA", "SU"], cleanedText };
    }

    // PATTERN 1c: "every Monday", "every Friday night", etc.
    const everyDayPattern =
      /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/i;
    const everyDayMatch = lowerText.match(everyDayPattern);
    if (everyDayMatch) {
      const dayName = everyDayMatch[1].toLowerCase();
      const dayCode = dayMap[dayName];
      if (dayCode) {
        cleanedText = text.replace(everyDayPattern, "").trim();
        return { frequency: "weekly", days: [dayCode], cleanedText };
      }
    }

    // PATTERN 1d: "every Mon/Wed/Fri" or "every M/W/F" or "every MWF"
    const multiDaySlashPattern =
      /\bevery\s+((?:(?:mon|tue|wed|thu|fri|sat|sun|m|t|w|r|f|s)\s*[\/,]\s*)+(?:mon|tue|wed|thu|fri|sat|sun|m|t|w|r|f|s))\b/i;
    const multiDaySlashMatch = lowerText.match(multiDaySlashPattern);
    if (multiDaySlashMatch) {
      const daysPart = multiDaySlashMatch[1];
      const dayTokens = daysPart.split(/[\/,\s]+/).filter(Boolean);
      const dayCodes = dayTokens.map((token) => dayMap[token.toLowerCase()])
        .filter(Boolean);
      if (dayCodes.length > 0) {
        cleanedText = text.replace(multiDaySlashPattern, "").trim();
        return { frequency: "weekly", days: dayCodes, cleanedText };
      }
    }

    // PATTERN 1e: "every Monday and Wednesday" - multiple days with "and"
    const multiDayAndPattern =
      /\bevery\s+((?:(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\s*(?:,\s*|\s+and\s+))+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat))\b/i;
    const multiDayAndMatch = lowerText.match(multiDayAndPattern);
    if (multiDayAndMatch) {
      const daysPart = multiDayAndMatch[1];
      const dayTokens = daysPart.split(/,\s*|\s+and\s+/).filter(Boolean);
      const dayCodes = dayTokens.map((token) =>
        dayMap[token.trim().toLowerCase()]
      ).filter(Boolean);
      if (dayCodes.length > 0) {
        cleanedText = text.replace(multiDayAndPattern, "").trim();
        return { frequency: "weekly", days: dayCodes, cleanedText };
      }
    }

    // PATTERN 1f: "every day" / "every single day"
    if (lowerText.match(/\bevery\s+(single\s+)?day\b/i)) {
      cleanedText = text.replace(/\bevery\s+(single\s+)?day\b/i, "").trim();
      return { frequency: "daily", cleanedText };
    }

    // PATTERN 1g: "every week"
    if (lowerText.match(/\bevery\s+week\b/i)) {
      // Use current day of week
      const date = new Date(currentDate + "T00:00:00");
      const dayOfWeek = date.getDay();
      const dayCode = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][dayOfWeek];
      cleanedText = text.replace(/\bevery\s+week\b/i, "").trim();
      return { frequency: "weekly", days: [dayCode], cleanedText };
    }

    // PATTERN 1h: "every month" or "every 15th"
    const everyMonthPattern = /\bevery\s+month\b/i;
    if (everyMonthPattern.test(lowerText)) {
      const date = new Date(currentDate + "T00:00:00");
      const dayOfMonth = date.getDate();
      cleanedText = text.replace(everyMonthPattern, "").trim();
      return {
        frequency: "monthly",
        monthlyPattern: { type: "dayOfMonth", value: dayOfMonth },
        cleanedText,
      };
    }

    // PATTERN 1i: "every 1st", "every 15th", "every last day"
    const everyOrdinalPattern = /\bevery\s+(\d+)(?:st|nd|rd|th)\b/i;
    const everyOrdinalMatch = lowerText.match(everyOrdinalPattern);
    if (everyOrdinalMatch) {
      const dayOfMonth = parseInt(everyOrdinalMatch[1], 10);
      cleanedText = text.replace(everyOrdinalPattern, "").trim();
      return {
        frequency: "monthly",
        monthlyPattern: { type: "dayOfMonth", value: dayOfMonth },
        cleanedText,
      };
    }

    // PATTERN 1j: "every first Monday", "every last Friday"
    const everyWeekdayPattern =
      /\bevery\s+(first|1st|second|2nd|third|3rd|fourth|4th|last)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/i;
    const everyWeekdayMatch = lowerText.match(everyWeekdayPattern);
    if (everyWeekdayMatch) {
      const [fullMatch, ordinal, dayName] = everyWeekdayMatch;
      const weekNumber = ordinal.match(/first|1st/)
        ? 1
        : ordinal.match(/second|2nd/)
        ? 2
        : ordinal.match(/third|3rd/)
        ? 3
        : ordinal.match(/fourth|4th/)
        ? 4
        : -1;
      const dayCode = dayMap[dayName.toLowerCase()];
      if (dayCode) {
        cleanedText = text.replace(new RegExp(fullMatch, "i"), "").trim();
        return {
          frequency: "monthly",
          monthlyPattern: {
            type: "weekdayOfMonth",
            value: weekNumber,
            weekday: dayCode,
          },
          cleanedText,
        };
      }
    }
  }

  // PATTERN 2: Frequency keywords WITHOUT "every"
  // "daily standup", "weekly meeting" - keep these words in the text as they describe the event
  if (lowerText.match(/\b(daily|everyday)\b/i)) {
    // Don't remove "daily" - it's part of the event description
    return { frequency: "daily", cleanedText: text };
  }

  if (lowerText.match(/\bweekly\b/i)) {
    // Don't remove "weekly" - it's part of the event description
    // Use current day of week
    const date = new Date(currentDate + "T00:00:00");
    const dayOfWeek = date.getDay();
    const dayCode = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][dayOfWeek];
    return { frequency: "weekly", days: [dayCode], cleanedText: text };
  }

  if (lowerText.match(/\bmonthly\b/i)) {
    // Don't remove "monthly" - it's part of the event description
    const date = new Date(currentDate + "T00:00:00");
    const dayOfMonth = date.getDate();
    return {
      frequency: "monthly",
      monthlyPattern: { type: "dayOfMonth", value: dayOfMonth },
      cleanedText: text,
    };
  }

  // PATTERN 3: "on weekdays" / "on weekends"
  if (lowerText.match(/\bon\s+week\s*days?\b/i)) {
    cleanedText = text.replace(/\bon\s+week\s*days?\b/i, "").trim();
    return {
      frequency: "weekly",
      days: ["MO", "TU", "WE", "TH", "FR"],
      cleanedText,
    };
  }
  if (lowerText.match(/\bon\s+weekends?\b/i)) {
    cleanedText = text.replace(/\bon\s+weekends?\b/i, "").trim();
    return { frequency: "weekly", days: ["SA", "SU"], cleanedText };
  }

  // PATTERN 4: Ambiguous day patterns - "Monday meeting", "Friday drinks"
  // These could be one-time OR recurring - flag as ambiguous
  const ambiguousDayPattern =
    /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\s+/i;
  const ambiguousMatch = lowerText.match(ambiguousDayPattern);
  if (ambiguousMatch) {
    const dayName = ambiguousMatch[1].toLowerCase();
    const dayCode = dayMap[dayName];
    if (dayCode) {
      // Don't clean the text - keep it as-is
      // Return with ambiguous flag so caller can decide
      return {
        frequency: "weekly",
        days: [dayCode],
        cleanedText: text,
        isAmbiguous: true,
      };
    }
  }

  // PATTERN 5: "biweekly" / "bi-weekly" / "fortnightly"
  if (lowerText.match(/\b(biweekly|bi-weekly|fortnightly)\b/i)) {
    const date = new Date(currentDate + "T00:00:00");
    const dayOfWeek = date.getDay();
    const dayCode = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][dayOfWeek];
    cleanedText = text.replace(/\b(biweekly|bi-weekly|fortnightly)\b/i, "")
      .trim();
    return { frequency: "weekly", days: [dayCode], interval: 2, cleanedText };
  }

  return null;
};

// Parse multiple events separated by "and" or comma
// Now returns notification info per event for semantic linking
const parseMultipleEvents = (
  text: string,
  customTimeLabels: readonly TimeLabel[] = [],
): Array<{
  text: string;
  time?: string;
  duration?: string;
  notification?: {
    enabled: boolean;
    value: number;
    unit: "minute" | "hour" | "day" | "week";
  };
}> => {
  if (!text) return [];

  // Split on " and " or comma while preserving context
  // Pattern matches: " and " or "," (with optional whitespace)
  const separatorPattern = /\s+and\s+|,\s*/i;
  const parts = text.split(separatorPattern);

  if (parts.length === 1) {
    // No separator found, treat as single event
    // Parse for notifications first
    const notifResult = parseNotifications(text);
    const textForTimeParsing = notifResult ? notifResult.cleanedText : text;

    const parseResult = parseTimeFromText(textForTimeParsing, customTimeLabels);
    if (parseResult) {
      return [{
        text: parseResult.cleanedText,
        time: parseResult.time,
        duration: parseResult.duration,
        ...(notifResult && {
          notification: {
            enabled: notifResult.enabled,
            value: notifResult.value,
            unit: notifResult.unit,
          },
        }),
      }];
    }
    return [{
      text: notifResult ? notifResult.cleanedText : text,
      ...(notifResult && {
        notification: {
          enabled: notifResult.enabled,
          value: notifResult.value,
          unit: notifResult.unit,
        },
      }),
    }];
  }

  // Multiple parts found - parse each independently for SEMANTIC LINKING
  // This ensures notifications only apply to the events they're associated with
  return parts.map((part) => {
    const trimmedPart = part.trim();

    // Parse notifications from this specific part
    const notifResult = parseNotifications(trimmedPart);
    const textForTimeParsing = notifResult
      ? notifResult.cleanedText
      : trimmedPart;

    // Parse time from the (potentially cleaned) text
    const parseResult = parseTimeFromText(textForTimeParsing, customTimeLabels);

    if (parseResult) {
      return {
        text: parseResult.cleanedText,
        time: parseResult.time,
        duration: parseResult.duration,
        ...(notifResult && {
          notification: {
            enabled: notifResult.enabled,
            value: notifResult.value,
            unit: notifResult.unit,
          },
        }),
      };
    }

    return {
      text: notifResult ? notifResult.cleanedText : trimmedPart,
      ...(notifResult && {
        notification: {
          enabled: notifResult.enabled,
          value: notifResult.value,
          unit: notifResult.unit,
        },
      }),
    };
  });
};

// Convert 24-hour time to 12-hour format
const _formatTime12Hour = lift((time: string) => {
  if (!time) return "";
  const [hours, minutes] = time.split(":").map(Number);
  const period = hours >= 12 ? "PM" : "AM";
  const hours12 = hours % 12 || 12;
  return `${hours12}:${minutes.toString().padStart(2, "0")} ${period}`;
});

const _formatTimeRange = lift(
  ({ startTime, duration }: { startTime: string; duration?: string }) => {
    if (!startTime) return "";

    const [startHours, startMinutes] = startTime.split(":").map(Number);
    const startPeriod = startHours >= 12 ? "PM" : "AM";
    const startHours12 = startHours % 12 || 12;

    // If no duration, just show start time
    if (!duration || duration === "none") {
      return `${startHours12}:${
        startMinutes.toString().padStart(2, "0")
      } ${startPeriod}`;
    }

    // Calculate end time from duration
    const durationMinutes = parseInt(duration, 10);
    const totalMinutes = startHours * 60 + startMinutes + durationMinutes;
    const endHours = Math.floor(totalMinutes / 60) % 24;
    const endMinutes = totalMinutes % 60;

    const endPeriod = endHours >= 12 ? "PM" : "AM";
    const endHours12 = endHours % 12 || 12;

    // If both times are in the same period, only show period once at the end
    if (startPeriod === endPeriod) {
      return `${startHours12}:${
        startMinutes.toString().padStart(2, "0")
      }-${endHours12}:${endMinutes.toString().padStart(2, "0")} ${endPeriod}`;
    } else {
      return `${startHours12}:${
        startMinutes.toString().padStart(2, "0")
      } ${startPeriod}-${endHours12}:${
        endMinutes.toString().padStart(2, "0")
      } ${endPeriod}`;
    }
  },
);

// Generate time slots based on settings
const _generateTimeSlots = lift(
  (
    { startTime, endTime, timeInterval }: {
      startTime: number;
      endTime: number;
      timeInterval: 30 | 60;
    },
  ) => {
    const timeSlots: Array<{ timeStr: string; displayTime: string }> = [];

    for (let hour = startTime; hour <= endTime; hour++) {
      const minutes = timeInterval === 60 ? [0] : [0, 30];

      for (const minute of minutes) {
        // Skip slots beyond endTime
        if (hour === endTime && minute > 0) continue;

        const timeStr = `${String(hour).padStart(2, "0")}:${
          String(minute).padStart(2, "0")
        }`;
        const displayTime = formatTimeAMPMCache(hour, minute);

        timeSlots.push({ timeStr, displayTime });
      }
    }

    return timeSlots;
  },
);

// Determine icon type for a note
const _getIconForNote = lift((note: Note | undefined) => {
  if (!note) return "🕐";

  // Check if recurring (has seriesId)
  if (
    note.seriesId && typeof note.seriesId === "string" && note.seriesId !== ""
  ) {
    return "🔁";
  }

  // Check if has notification enabled
  if (note.notificationEnabled === true) {
    return "⏰";
  }

  // Default clock icon
  return "🕐";
});

// Determine button className for a note
const _getButtonClassName = lift((note: Note | undefined) => {
  if (!note) return "clock-button";

  // Only add alert class if notification is truly enabled
  if (note.notificationEnabled === true) {
    return "clock-button clock-button-alert";
  }

  return "clock-button";
});

// Handler to navigate to previous day
const previousDay = handler<
  never,
  { currentDate: Writable<string> }
>((_event, { currentDate }) => {
  const current = new Date(currentDate.get());
  current.setDate(current.getDate() - 1);
  currentDate.set(current.toISOString().split("T")[0]);
});

// Handler to navigate to next day
const nextDay = handler<
  never,
  { currentDate: Writable<string> }
>((_event, { currentDate }) => {
  const current = new Date(currentDate.get());
  current.setDate(current.getDate() + 1);
  currentDate.set(current.toISOString().split("T")[0]);
});

// Handler to go to today
// OPTIMIZATION v508: Also update viewedYearMonth when going to today
const goToToday = handler<
  never,
  { currentDate: Writable<string>; viewedYearMonth: Writable<string> }
>((_event, { currentDate, viewedYearMonth }) => {
  const today = getTodayISO();
  currentDate.set(today);
  viewedYearMonth.set(today.substring(0, 7));
});

// Handler to navigate to previous month
// OPTIMIZATION v508: Handlers also update viewedYearMonth for proper separation
const previousMonth = handler<
  never,
  { currentDate: Writable<string>; viewedYearMonth: Writable<string> }
>((_event, { currentDate, viewedYearMonth }) => {
  const current = new Date(currentDate.get() + "T00:00:00");
  current.setMonth(current.getMonth() - 1);
  const newDate = current.toISOString().split("T")[0];
  currentDate.set(newDate);
  viewedYearMonth.set(newDate.substring(0, 7));
});

// Handler to navigate to next month
const nextMonth = handler<
  never,
  { currentDate: Writable<string>; viewedYearMonth: Writable<string> }
>((_event, { currentDate, viewedYearMonth }) => {
  const current = new Date(currentDate.get() + "T00:00:00");
  current.setMonth(current.getMonth() + 1);
  const newDate = current.toISOString().split("T")[0];
  currentDate.set(newDate);
  viewedYearMonth.set(newDate.substring(0, 7));
});

// Handler to select a day from the calendar
// OPTIMIZATION v508: Also update viewedYearMonth when selecting a day
const selectDayFromCalendar = handler<
  { target: { dataset: { date: string } } },
  { currentDate: Writable<string>; viewedYearMonth: Writable<string> }
>(({ target }, { currentDate, viewedYearMonth }) => {
  const date = target.dataset.date;
  if (date) {
    currentDate.set(date);
    // Update viewed month if selecting a day in a different month
    const newYearMonth = date.substring(0, 7);
    if (viewedYearMonth.get() !== newYearMonth) {
      viewedYearMonth.set(newYearMonth);
    }
  }
});

// Handler to change month
const _changeMonth = handler<
  { detail: { value: number } },
  { currentDate: Writable<string> }
>(({ detail }, { currentDate }) => {
  const current = new Date(currentDate.get() + "T00:00:00");
  current.setMonth(detail.value);
  currentDate.set(current.toISOString().split("T")[0]);
});

// Handler to change year
const _changeYear = handler<
  { detail: { value: number } },
  { currentDate: Writable<string> }
>(({ detail }, { currentDate }) => {
  const current = new Date(currentDate.get() + "T00:00:00");
  current.setFullYear(detail.value);
  currentDate.set(current.toISOString().split("T")[0]);
});

// Handler to add a new note to current date
const addNote = handler<
  never,
  { entries: Writable<DayEntry[]>; currentDate: Writable<string> }
>((_event, { entries, currentDate }) => {
  const date = currentDate.get();
  const allEntries = entries.get();
  const existingIndex = allEntries.findIndex((e: DayEntry) => e.date === date);
  const newNoteId = Date.now().toString();
  const newNote: Note = { id: newNoteId, text: "" };

  // Notes start in view mode - user can click to edit

  if (existingIndex >= 0) {
    // Add note to existing entry - make sure to create a completely new object
    const updated = [...allEntries];
    const existingNotes = Array.from(updated[existingIndex].notes || []);
    // Create a fresh plain object array to avoid Cell wrapping
    const newNotes: Note[] = [...existingNotes];
    newNotes.push(newNote);
    updated[existingIndex] = {
      date,
      notes: newNotes,
    };
    entries.set(updated);
  } else {
    // Create new entry with note
    entries.set([...allEntries, { date, notes: [newNote] }]);
  }
});

// Pre-computed Settings time select items (for Start Time and End Time)
const timeSelectItems = Array.from({ length: 24 }, (_, i) => ({
  value: i,
  label: formatTimeAMPMCache(i, 0),
}));

// RRULE expansion logic
// OPTIMIZATION v506: Direct calculation instead of day-by-day iteration
// Reduces O(n × days) to O(n × occurrences)
const expandSeriesInRange = (
  series: RecurringSeries,
  rangeStart: string, // ISO date
  rangeEnd: string, // ISO date
): string[] => {
  const dates: string[] = [];

  // Parse RRULE once
  const rruleParts: Record<string, string> = {};
  series.rrule.split(";").forEach((part) => {
    const [key, value] = part.split("=");
    rruleParts[key] = value;
  });

  const freq = rruleParts["FREQ"];
  const interval = parseInt(rruleParts["INTERVAL"] || "1", 10);
  const byday = rruleParts["BYDAY"]?.split(",") || [];
  const bymonthday = rruleParts["BYMONTHDAY"]
    ? parseInt(rruleParts["BYMONTHDAY"], 10)
    : null;

  // Day name to JS day number
  const dayMap: Record<string, number> = {
    "SU": 0,
    "MO": 1,
    "TU": 2,
    "WE": 3,
    "TH": 4,
    "FR": 5,
    "SA": 6,
  };

  // Parse dates as timestamps for fast comparison
  const dtstartTime = new Date(series.dtstart + "T00:00:00").getTime();
  const rangeStartTime = new Date(rangeStart + "T00:00:00").getTime();
  const rangeEndTime = new Date(rangeEnd + "T00:00:00").getTime();
  const untilTime = series.until
    ? new Date(series.until + "T00:00:00").getTime()
    : new Date("2099-12-31T00:00:00").getTime();

  const effectiveEnd = Math.min(rangeEndTime, untilTime);
  const effectiveStart = Math.max(rangeStartTime, dtstartTime);

  if (effectiveStart > effectiveEnd) return dates;

  const maxOccurrences = series.count || 1000;
  const MS_PER_DAY = 86400000;

  // Helper to format timestamp to ISO date string
  const toDateStr = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
      String(d.getDate()).padStart(2, "0")
    }`;
  };

  if (freq === "DAILY") {
    // Direct calculation: find first occurrence >= effectiveStart
    const daysSinceStart = Math.floor(
      (effectiveStart - dtstartTime) / MS_PER_DAY,
    );
    const firstOccurrenceOffset = Math.ceil(daysSinceStart / interval) *
      interval;
    let currentTime = dtstartTime + firstOccurrenceOffset * MS_PER_DAY;

    // Adjust if we're before the range
    if (currentTime < effectiveStart) {
      currentTime += interval * MS_PER_DAY;
    }

    let count = 0;
    while (currentTime <= effectiveEnd && count < maxOccurrences) {
      dates.push(toDateStr(currentTime));
      currentTime += interval * MS_PER_DAY;
      count++;
    }
  } else if (freq === "WEEKLY") {
    // Get target days of week
    const startDate = new Date(dtstartTime);
    const targetDays = byday.length > 0
      ? byday.map((d) => dayMap[d]).filter((d) => d !== undefined)
      : [startDate.getDay()];

    // Sort target days for consistent iteration
    targetDays.sort((a, b) => a - b);

    // Find the first week that could contain occurrences
    const daysSinceStart = Math.floor(
      (effectiveStart - dtstartTime) / MS_PER_DAY,
    );
    const weeksSinceStart = Math.floor(daysSinceStart / 7);
    const firstWeekOffset = Math.floor(weeksSinceStart / interval) * interval;

    let currentWeekStart = dtstartTime + firstWeekOffset * 7 * MS_PER_DAY;
    // Adjust to actual week start (Sunday)
    const startDayOfWeek = startDate.getDay();
    currentWeekStart -= startDayOfWeek * MS_PER_DAY;

    let count = 0;
    while (currentWeekStart <= effectiveEnd && count < maxOccurrences) {
      for (const dayOfWeek of targetDays) {
        const occurrenceTime = currentWeekStart + dayOfWeek * MS_PER_DAY;

        if (
          occurrenceTime >= effectiveStart &&
          occurrenceTime <= effectiveEnd &&
          occurrenceTime >= dtstartTime
        ) {
          dates.push(toDateStr(occurrenceTime));
          count++;
          if (count >= maxOccurrences) break;
        }
      }
      currentWeekStart += interval * 7 * MS_PER_DAY;
    }
  } else if (freq === "MONTHLY") {
    const startDate = new Date(dtstartTime);
    const rangeStartDate = new Date(effectiveStart);

    // Determine starting month
    let year = rangeStartDate.getFullYear();
    let month = rangeStartDate.getMonth();

    // Adjust for interval
    const startYear = startDate.getFullYear();
    const startMonth = startDate.getMonth();
    const monthsSinceStart = (year - startYear) * 12 + (month - startMonth);
    const monthOffset = Math.floor(monthsSinceStart / interval) * interval;
    year = startYear + Math.floor((startMonth + monthOffset) / 12);
    month = (startMonth + monthOffset) % 12;

    let count = 0;
    while (count < maxOccurrences) {
      let targetDay: number | null = null;

      if (bymonthday !== null) {
        // Specific day of month
        targetDay = bymonthday;
      } else if (byday.length > 0 && byday[0].length > 2) {
        // Nth weekday of month (e.g., "2TH" = second Thursday)
        const byDayPattern = byday[0];
        const position = parseInt(
          byDayPattern.substring(0, byDayPattern.length - 2),
          10,
        );
        const dayCode = byDayPattern.substring(byDayPattern.length - 2);
        const targetDayOfWeek = dayMap[dayCode];

        if (targetDayOfWeek !== undefined) {
          // Find the Nth occurrence of this weekday in the month
          const firstOfMonth = new Date(year, month, 1);
          const firstDayOfWeek = firstOfMonth.getDay();
          let dayOfMonth = 1 + ((targetDayOfWeek - firstDayOfWeek + 7) % 7);
          dayOfMonth += (position - 1) * 7;

          // Check if this day exists in the month
          const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
          if (dayOfMonth <= lastDayOfMonth) {
            targetDay = dayOfMonth;
          }
        }
      } else {
        // Same day of month as dtstart
        targetDay = startDate.getDate();
      }

      if (targetDay !== null) {
        // Check if day exists in this month
        const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
        if (targetDay <= lastDayOfMonth) {
          const occurrenceTime = new Date(year, month, targetDay).getTime();

          if (occurrenceTime > effectiveEnd) break;

          if (
            occurrenceTime >= effectiveStart && occurrenceTime >= dtstartTime
          ) {
            dates.push(toDateStr(occurrenceTime));
            count++;
          }
        }
      }

      // Advance by interval months
      month += interval;
      while (month >= 12) {
        month -= 12;
        year++;
      }

      // Safety check - don't go past year 2100
      if (year > 2100) break;
    }
  }

  return dates;
};

// Expand all series for a given month and apply overrides
// OPTIMIZATION v507: Added memoization to avoid recomputing when inputs unchanged
const expandRecurringEventsForMonth = lift(
  ({
    series,
    overrides,
    yearMonth,
  }: {
    series: RecurringSeries[];
    overrides: SeriesOverride[];
    yearMonth: string; // "2025-11"
  }): Record<string, Note[]> => {
    // Handle undefined yearMonth (can happen during initialization)
    if (!yearMonth || typeof yearMonth !== "string") {
      return {};
    }

    // OPTIMIZATION v507: Check cache first (using content-based keys)
    const seriesKey = getSeriesCacheKey(series);
    const overridesKey = getOverridesCacheKey(overrides);
    if (
      _recurringCache &&
      _recurringCache.yearMonth === yearMonth &&
      _recurringCache.seriesKey === seriesKey &&
      _recurringCache.overridesKey === overridesKey
    ) {
      return _recurringCache.result;
    }

    const [year, month] = yearMonth.split("-").map(Number);
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
    // OPTIMIZATION v507: Use getDaysInMonth instead of Date object
    const lastDay = getDaysInMonth(year, month - 1); // month is 1-indexed here
    const monthEnd = `${year}-${String(month).padStart(2, "0")}-${
      String(lastDay).padStart(2, "0")
    }`;

    // Build override map for quick lookup
    const overrideMap = new Map<string, SeriesOverride>();
    overrides.forEach((override) => {
      const key = `${override.seriesId}:${override.recurrenceDate}`;
      overrideMap.set(key, override);
    });

    // Expand all series
    const notesByDate: Record<string, Note[]> = {};

    series.forEach((s) => {
      // Skip undefined or invalid series entries
      if (!s || !s.dtstart || !s.rrule) return;

      const dates = expandSeriesInRange(s, monthStart, monthEnd);

      dates.forEach((date) => {
        const key = `${s.seriesId}:${date}`;
        const override = overrideMap.get(key);

        // Skip if canceled or deleted
        if (override?.canceled || override?.deleted) return;

        // Create note with overrides applied
        const note: Note = {
          id: key,
          seriesId: s.seriesId,
          text: override?.text ?? s.text,
          scheduledTime: override?.scheduledTime ?? s.scheduledTime,
          duration: override?.duration ?? s.duration,
          notificationEnabled: override?.notificationEnabled ??
            s.notificationEnabled,
          notificationValue: override?.notificationValue ?? s.notificationValue,
          notificationUnit: override?.notificationUnit ?? s.notificationUnit,
        };

        if (!notesByDate[date]) {
          notesByDate[date] = [];
        }
        notesByDate[date].push(note);
      });
    });

    // OPTIMIZATION v507: Cache result
    _recurringCache = {
      yearMonth,
      seriesKey,
      overridesKey,
      result: notesByDate,
    };

    return notesByDate;
  },
);

// Handler to add a note at a specific time
const addNoteAtTime = handler<
  never,
  {
    entries: Writable<DayEntry[]>;
    currentDate: Writable<string>;
    scheduledTime: string;
    duration?: number;
  }
>((_event, { entries, currentDate, scheduledTime, duration }) => {
  const date = currentDate.get();
  const allEntries = entries.get();
  const existingIndex = allEntries.findIndex((e: DayEntry) => e.date === date);
  const newNoteId = Date.now().toString();
  const finalDuration = duration !== undefined ? duration : 60;
  const newNote: Note = {
    id: newNoteId,
    text: "",
    scheduledTime,
    duration: String(finalDuration), // Use provided duration or default to 1 hour
  };

  if (existingIndex >= 0) {
    const updated = [...allEntries];
    const existingNotes = Array.from(updated[existingIndex].notes || []);
    const newNotes: Note[] = [...existingNotes];
    newNotes.push(newNote);
    updated[existingIndex] = {
      date,
      notes: newNotes,
    };
    entries.set(updated);
  } else {
    entries.set([...allEntries, { date, notes: [newNote] }]);
  }
});

// Handler to update a specific note
const updateNote = handler<
  { target: { value: string } },
  {
    entries: Writable<DayEntry[]>;
    currentDate: Writable<string>;
    noteId: string;
    customTimeLabels: Writable<TimeLabel[]>;
  }
>(({ target }, { entries, currentDate, noteId, customTimeLabels }) => {
  const text = target?.value ?? "";
  const date = currentDate.get();
  const allEntries = entries.get();
  const existingIndex = allEntries.findIndex((e: DayEntry) => e.date === date);
  const configuredCustomTimeLabels = customTimeLabels.get();

  if (existingIndex >= 0) {
    const updated = [...allEntries];
    const notes = Array.from(updated[existingIndex].notes || []);
    const noteIndex = notes.findIndex((n: any) => n.id === noteId);

    if (noteIndex >= 0) {
      const currentNote = notes[noteIndex];

      // Normal single-event handling first - parse time from text
      let finalText = text;
      let newScheduledTime = currentNote.scheduledTime;
      let newDuration = currentNote.duration;

      // Only parse and remove time if note doesn't already have a scheduled time
      if (!currentNote.scheduledTime) {
        const parseResult = parseTimeFromText(
          text,
          configuredCustomTimeLabels,
        );
        if (parseResult) {
          // Use the cleaned text (with time removed) and set the scheduled time
          finalText = parseResult.cleanedText;
          newScheduledTime = parseResult.time;
          newDuration = parseResult.duration;
        }
      }

      // AFTER normal parsing, check for multi-event detection
      // Look for " and " or commas
      if (text.match(/\s+and\s+|,/i)) {
        const events = parseMultipleEvents(
          text,
          configuredCustomTimeLabels,
        );

        // Only split if we got multiple events AND at least the first event has a parseable time
        if (events.length > 1 && events[0].time) {
          // Multiple events detected - split them with SEMANTIC NOTIFICATION LINKING
          const newNotes = [...notes];

          // Update current note with first event (with its specific notification if any)
          const firstEvent = events[0];
          newNotes[noteIndex] = {
            id: noteId,
            text: firstEvent.text,
            ...(firstEvent.time && { scheduledTime: firstEvent.time }),
            ...(firstEvent.duration && { duration: firstEvent.duration }),
            // Only apply notification if THIS EVENT has one
            ...(firstEvent.notification && {
              notificationEnabled: firstEvent.notification.enabled,
              notificationValue: firstEvent.notification.value,
              notificationUnit: firstEvent.notification.unit,
            }),
          };

          // Add remaining events as new notes (each with their own notification if any)
          for (let i = 1; i < events.length; i++) {
            const event = events[i];
            newNotes.push({
              id: (Date.now() + i).toString(),
              text: event.text,
              ...(event.time && { scheduledTime: event.time }),
              ...(event.duration && { duration: event.duration }),
              // Only apply notification if THIS EVENT has one
              ...(event.notification && {
                notificationEnabled: event.notification.enabled,
                notificationValue: event.notification.value,
                notificationUnit: event.notification.unit,
              }),
            });
          }

          updated[existingIndex] = { date, notes: newNotes };
          entries.set(updated);
          return;
        }
      }

      // Single event - parse for notifications
      const notifResult = parseNotifications(text);

      // Create fresh plain objects to avoid Cell wrapping
      const updatedNotes: Note[] = notes.map((n: any, idx: number) => {
        if (idx === noteIndex) {
          // Update the current note being edited
          return {
            ...n,
            text: finalText,
            ...(newScheduledTime && { scheduledTime: newScheduledTime }),
            ...(newDuration && { duration: newDuration }),
            ...(notifResult && {
              notificationEnabled: notifResult.enabled,
              notificationValue: notifResult.value,
              notificationUnit: notifResult.unit,
            }),
          };
        } else {
          // Preserve other notes unchanged
          return n;
        }
      });
      updated[existingIndex] = { date, notes: updatedNotes };
      entries.set(updated);
    }
  }
});

// Helper function to perform deletion logic
const performDeleteLogic = (state: {
  entries: Writable<DayEntry[]>;
  recurringSeries: Writable<RecurringSeries[]>;
  seriesOverrides: Writable<SeriesOverride[]>;
  noteId: string;
  date: string;
  deleteScope: string;
}) => {
  const {
    entries,
    recurringSeries,
    seriesOverrides,
    noteId,
    date,
    deleteScope,
  } = state;

  // Check if this is a recurring event
  if (noteId.includes(":")) {
    const [seriesId, occurrenceDate] = noteId.split(":");

    if (deleteScope === "this") {
      // Delete only this occurrence by creating a deletion override
      const allOverrides = seriesOverrides.get();
      const override: SeriesOverride = {
        seriesId,
        recurrenceDate: occurrenceDate,
        deleted: true,
      };

      const existingOverrideIndex = allOverrides.findIndex(
        (o: SeriesOverride) =>
          o.seriesId === seriesId && o.recurrenceDate === occurrenceDate,
      );

      if (existingOverrideIndex >= 0) {
        const updated = [...allOverrides];
        updated[existingOverrideIndex] = override;
        seriesOverrides.set(updated);
      } else {
        seriesOverrides.set([...allOverrides, override]);
      }
      return;
    }

    if (deleteScope === "future") {
      // End the series before this occurrence
      const allSeries = recurringSeries.get();
      const seriesIndex = allSeries.findIndex((s: RecurringSeries) =>
        s.seriesId === seriesId
      );

      if (seriesIndex >= 0) {
        const currentOccurrence = new Date(occurrenceDate + "T00:00:00");
        const dayBefore = new Date(currentOccurrence);
        dayBefore.setDate(dayBefore.getDate() - 1);
        const untilDate = dayBefore.toISOString().split("T")[0];

        const updated = [...allSeries];
        updated[seriesIndex] = {
          ...updated[seriesIndex],
          until: untilDate,
        };
        recurringSeries.set(updated);
      }
      return;
    }

    if (deleteScope === "all") {
      // Delete the entire series family (including all ancestors and descendants)
      const allSeries = recurringSeries.get();

      // Helper function to find all related series IDs
      const findRelatedSeriesIds = (targetId: string): Set<string> => {
        const relatedIds = new Set<string>();
        relatedIds.add(targetId);

        // Find the root ancestor by walking up the parentSeriesId chain
        let currentId = targetId;
        let currentSeries = allSeries.find((s: RecurringSeries) =>
          s.seriesId === currentId
        );

        while (currentSeries?.parentSeriesId) {
          relatedIds.add(currentSeries.parentSeriesId);
          currentId = currentSeries.parentSeriesId;
          currentSeries = allSeries.find((s: RecurringSeries) =>
            s.seriesId === currentId
          );
        }

        // Now find all descendants by walking down from all known ancestors
        const idsToCheck = Array.from(relatedIds);
        for (const id of idsToCheck) {
          const children = allSeries.filter((s: RecurringSeries) =>
            s.parentSeriesId === id
          );
          for (const child of children) {
            if (!relatedIds.has(child.seriesId)) {
              relatedIds.add(child.seriesId);
              idsToCheck.push(child.seriesId); // Check this child's children too
            }
          }
        }

        return relatedIds;
      };

      const relatedSeriesIds = findRelatedSeriesIds(seriesId);

      // Delete all related series
      const filtered = allSeries.filter((s: RecurringSeries) =>
        !relatedSeriesIds.has(s.seriesId)
      );
      recurringSeries.set(filtered);

      // Delete all overrides for all related series
      const allOverrides = seriesOverrides.get();
      const filteredOverrides = allOverrides.filter((o: SeriesOverride) =>
        !relatedSeriesIds.has(o.seriesId)
      );
      seriesOverrides.set(filteredOverrides);

      return;
    }
  }

  // Handle one-off event deletion
  const allEntries = entries.get();
  const existingIndex = allEntries.findIndex((e: DayEntry) => e.date === date);

  if (existingIndex >= 0) {
    const updated = [...allEntries];
    const notes = Array.from(updated[existingIndex].notes || []);
    const filteredNotes: Note[] = notes
      .filter((n: any) => n.id !== noteId);
    updated[existingIndex] = { date, notes: filteredNotes };
    entries.set(updated);
  }
};

// Handler to delete a note
const deleteNote = handler<
  never,
  {
    entries: Writable<DayEntry[]>;
    recurringSeries: Writable<RecurringSeries[]>;
    seriesOverrides: Writable<SeriesOverride[]>;
    currentDate: Writable<string>;
    noteId: string;
    seriesId?: string;
    deletionConfirmingScopeCell: Writable<boolean>;
    deletionPendingCell: Writable<{ noteId: string; date: string } | null>;
    scheduleEditScopeCell: Writable<string>;
  }
>((
  _event,
  {
    entries,
    recurringSeries,
    seriesOverrides,
    currentDate,
    noteId,
    seriesId,
    deletionConfirmingScopeCell,
    deletionPendingCell,
    scheduleEditScopeCell,
  },
) => {
  const date = currentDate.get();

  // Check if this is a recurring event (has seriesId or noteId contains ':')
  const isRecurring = seriesId || noteId.includes(":");

  if (isRecurring) {
    // Check if we need to show confirmation dialog
    const isConfirming = deletionConfirmingScopeCell.get();

    if (!isConfirming) {
      // Not yet confirming - show confirmation dialog
      deletionPendingCell.set({ noteId, date });
      deletionConfirmingScopeCell.set(true);
      return;
    }

    // User has confirmed scope - proceed with deletion
    const deleteScope = scheduleEditScopeCell.get();
    deletionConfirmingScopeCell.set(false);

    performDeleteLogic({
      entries,
      recurringSeries,
      seriesOverrides,
      noteId,
      date,
      deleteScope,
    });

    deletionPendingCell.set(null);
    return;
  }

  // One-off event - delete directly
  performDeleteLogic({
    entries,
    recurringSeries,
    seriesOverrides,
    noteId,
    date,
    deleteScope: "this",
  });
});

// Handler to enable inline editing of a note
const _enableNoteEditing = handler<
  never,
  { noteId: string; editingNoteId: Writable<string> }
>((_event, { noteId, editingNoteId }) => {
  editingNoteId.set(noteId);
});

export default pattern<Input, Output>(
  (
    {
      entries,
      name,
      customTimeLabels,
      recurringSeries,
      seriesOverrides,
      startTime,
      endTime,
      timeInterval,
      showMonthView,
    },
  ) => {
    // OPTIMIZATION v508: Use cached today instead of new Date() in hot path
    const today = getTodayISO();
    const currentDate = Writable.of<string>(today);

    // OPTIMIZATION v508: Separate viewedYearMonth from currentDate
    // This allows day selection within month without recomputing grid
    const viewedYearMonth = Writable.of<string>(today.substring(0, 7));

    // OPTIMIZATION v508: Consolidated date parsing - single derivation for all date info
    // Eliminates redundant Date object creations in currentDateInfo, _yearItems, _currentMonthIndex
    const currentDateParsed = derive(currentDate, (date: string) => {
      const [year, month, day] = date.split("-").map(Number);
      const monthIndex = month - 1;
      return {
        year,
        month,
        day,
        monthIndex,
        monthName: MONTH_NAMES[monthIndex],
        monthNameShort: MONTH_NAMES_SHORT[monthIndex],
        yearMonth: date.substring(0, 7),
        // Pre-compute year dropdown items (±10 years)
        yearItems: Array.from({ length: 21 }, (_, i) => ({
          value: year - 10 + i,
          label: (year - 10 + i).toString(),
        })),
      };
    });

    // Keep currentYearMonth for backward compatibility (derived from parsed)
    const currentYearMonth = derive(
      currentDateParsed,
      (parsed: any) => parsed.yearMonth,
    );

    // Expand recurring events for the current month
    const recurringNotesByDate = expandRecurringEventsForMonth({
      series: recurringSeries,
      overrides: seriesOverrides,
      yearMonth: currentYearMonth,
    });

    // Merge one-off entries with recurring events
    // OPTIMIZATION v508: Use concat and reference reuse to reduce allocations
    const mergedEntries = derive(
      { entries, recurringNotesByDate },
      (
        { entries, recurringNotesByDate }: {
          entries: DayEntry[];
          recurringNotesByDate: Record<string, Note[]> | null | undefined;
        },
      ) => {
        // Fast path: no recurring events, return original array
        if (
          !recurringNotesByDate ||
          Object.keys(recurringNotesByDate).length === 0
        ) {
          return entries;
        }

        // Build result array with optimized allocations
        const result: DayEntry[] = [];
        const processedDates = new Set<string>();

        // Process entries, merging with recurring where needed
        for (const entry of entries) {
          processedDates.add(entry.date);
          const recurring = recurringNotesByDate[entry.date];

          if (recurring) {
            // Use concat instead of spread for better performance
            result.push({
              date: entry.date,
              notes: entry.notes.concat(recurring),
            });
          } else {
            // Reuse reference when no merge needed
            result.push(entry);
          }
        }

        // Add dates that only have recurring events
        for (const date in recurringNotesByDate) {
          if (!processedDates.has(date)) {
            result.push({
              date,
              notes: recurringNotesByDate[date],
            });
          }
        }

        return result;
      },
    );

    // OPTIMIZATION v10: Pre-computed time slot grid - only recomputes when time settings change
    const timeSlotGrid = derive(
      { startTime, endTime, timeInterval },
      ({ startTime, endTime, timeInterval }) =>
        buildTimeSlotGrid(startTime, endTime, timeInterval),
    );

    // OPTIMIZATION v12: Object-based entry lookup for O(1) access by date
    const entriesByDateMap = derive(
      mergedEntries,
      (mergedEntries: DayEntry[]) => {
        const map: Record<string, DayEntry> = {};
        for (const entry of mergedEntries) {
          map[entry.date] = entry;
        }
        return map;
      },
    );

    // OPTIMIZATION v13: Series map for O(1) lookup by seriesId
    const _seriesMap = derive(
      recurringSeries,
      (series: RecurringSeries[]) => {
        const map: Record<string, RecurringSeries> = {};
        for (const s of series) {
          if (s && s.seriesId) {
            map[s.seriesId] = s;
          }
        }
        return map;
      },
    );

    // OPTIMIZATION v13: Override map for O(1) lookup by seriesId:date key
    const _overrideMap = derive(
      seriesOverrides,
      (overrides: SeriesOverride[]) => {
        const map: Record<string, SeriesOverride> = {};
        for (const o of overrides) {
          if (o && o.seriesId && o.recurrenceDate) {
            map[`${o.seriesId}:${o.recurrenceDate}`] = o;
          }
        }
        return map;
      },
    );

    // OPTIMIZATION v12: O(1) lookup instead of O(n) find()
    const currentEntry = derive(
      { entriesByDateMap, currentDate },
      (
        { entriesByDateMap, currentDate }: {
          entriesByDateMap: Record<string, DayEntry>;
          currentDate: string;
        },
      ) => {
        return entriesByDateMap[currentDate];
      },
    );

    // OPTIMIZATION v10: Pre-computed intervals for current date's notes
    const currentDateIntervals = derive(
      { currentEntry, timeInterval },
      ({ currentEntry, timeInterval }) => {
        if (!currentEntry?.notes) {
          return {
            scheduled: [] as Note[],
            unscheduled: [] as Note[],
            notesByTime: {} as Record<string, Note>,
            occupiedIntervals: [] as Array<[number, number]>,
          };
        }

        const scheduled: Note[] = [];
        const unscheduled: Note[] = [];
        const notesByTime: Record<string, Note> = {};
        const occupiedIntervals: Array<[number, number]> = [];

        for (const note of currentEntry.notes) {
          if (note.scheduledTime) {
            scheduled.push(note);
            notesByTime[note.scheduledTime] = note;
          } else {
            unscheduled.push(note);
          }
        }

        // Sort scheduled notes by time
        scheduled.sort((a: Note, b: Note) =>
          a.scheduledTime!.localeCompare(b.scheduledTime!)
        );

        // Build occupied intervals
        for (const note of scheduled) {
          const [h, m] = note.scheduledTime!.split(":").map(Number);
          const start = h * 60 + m;
          const duration = note.duration
            ? parseInt(note.duration, 10)
            : timeInterval;
          occupiedIntervals.push([start, start + duration]);
        }

        return { scheduled, unscheduled, notesByTime, occupiedIntervals };
      },
    );

    // OPTIMIZATION v11: Maximum performance optimizations
    // - Cached empty ghost slots (uses map once instead of push loop)
    // - Track scheduled items during main loop (eliminates filter call)
    // - Simplified time processing using pre-sorted timeSlotGrid
    const unifiedTimeline = derive(
      { timeSlotGrid, currentDateIntervals, timeInterval },
      ({ timeSlotGrid, currentDateIntervals, timeInterval }: any) => {
        const { scheduled, unscheduled, notesByTime, occupiedIntervals } =
          currentDateIntervals;

        const items: any[] = [];

        // If no notes, return pre-computed ghost slots grid
        if (scheduled.length === 0 && unscheduled.length === 0) {
          for (const slot of timeSlotGrid) {
            items.push({
              type: "ghost",
              order: slot.order,
              note: undefined,
              timeStr: slot.timeStr,
              displayTime: slot.displayTime,
              showGhost: true,
              showUnscheduled: false,
              showScheduled: false,
            });
          }
          return items;
        }
        // OPTIMIZATION v11: Track scheduled items during main loop to avoid filter() at the end
        const scheduledItemsForAdaptive: any[] = [];

        // Binary search for overlap check - O(log n)
        const isMinuteOverlapped = (minute: number): boolean => {
          let left = 0;
          let right = occupiedIntervals.length - 1;

          while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const [start, end] = occupiedIntervals[mid];

            if (minute >= start && minute < end) {
              return minute > start;
            } else if (minute < start) {
              right = mid - 1;
            } else {
              left = mid + 1;
            }
          }
          return false;
        };

        // Binary search for range overlap - O(log n)
        const doesRangeOverlap = (
          rangeStart: number,
          rangeEnd: number,
        ): boolean => {
          if (occupiedIntervals.length === 0) return false;

          let left = 0;
          let right = occupiedIntervals.length - 1;

          while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (occupiedIntervals[mid][1] <= rangeStart) {
              left = mid + 1;
            } else {
              right = mid;
            }
          }

          for (let i = left; i < occupiedIntervals.length; i++) {
            const [start, end] = occupiedIntervals[i];
            if (start >= rangeEnd) break;
            if (rangeStart < end && rangeEnd > start) {
              return true;
            }
          }
          return false;
        };

        // Add unscheduled notes first
        // OPTIMIZATION v12: Pre-compute icon and buttonClassName for each note
        unscheduled.forEach((n: Note, idx: number) => {
          items.push({
            type: "unscheduled",
            order: -1000 + idx,
            note: n,
            timeStr: "",
            displayTime: "",
            showGhost: false,
            showUnscheduled: true,
            showScheduled: false,
            // Pre-computed values for render
            icon: computeIconForNote(n),
            buttonClass: computeButtonClassName(n),
            formattedTime: "",
          });
        });

        // OPTIMIZATION v11: Process times without Set creation
        // Use timeSlotGrid directly (already sorted) and merge note times
        const noteTimes = Object.keys(notesByTime).sort();
        const existingTimeStrs = new Set<string>();

        // Merge timeSlotGrid times with note times using two-pointer approach
        let gridIdx = 0;
        let noteIdx = 0;
        const sortedTimes: string[] = [];

        while (gridIdx < timeSlotGrid.length || noteIdx < noteTimes.length) {
          const gridTime = gridIdx < timeSlotGrid.length
            ? timeSlotGrid[gridIdx].timeStr
            : null;
          const noteTime = noteIdx < noteTimes.length
            ? noteTimes[noteIdx]
            : null;

          if (gridTime && (!noteTime || gridTime < noteTime)) {
            sortedTimes.push(gridTime);
            gridIdx++;
          } else if (noteTime && (!gridTime || noteTime < gridTime)) {
            sortedTimes.push(noteTime);
            noteIdx++;
          } else {
            // Equal - add once and advance both
            sortedTimes.push(gridTime!);
            gridIdx++;
            noteIdx++;
          }
        }

        for (const timeStr of sortedTimes) {
          const [hourStr, minuteStr] = timeStr.split(":");
          const hour = parseInt(hourStr, 10);
          const minute = parseInt(minuteStr, 10);
          const order = hour * 100 + minute;

          const noteAtTime = notesByTime[timeStr];

          if (noteAtTime) {
            const noteDuration = noteAtTime.duration
              ? parseInt(noteAtTime.duration, 10)
              : timeInterval;
            const hideDuration = noteDuration === timeInterval;
            // OPTIMIZATION v12: Pre-compute display values
            const scheduledItem = {
              type: "scheduled",
              order: order,
              note: noteAtTime,
              timeStr: timeStr,
              displayTime: formatTimeAMPMCache(hour, minute),
              showGhost: false,
              showUnscheduled: false,
              showScheduled: true,
              hideDuration: hideDuration,
              // Pre-computed values for render
              icon: computeIconForNote(noteAtTime),
              buttonClass: computeButtonClassName(noteAtTime),
              formattedTime: hideDuration
                ? computeTimeRange(timeStr, undefined)
                : computeTimeRange(timeStr, noteAtTime.duration),
            };
            items.push(scheduledItem);
            // OPTIMIZATION v11: Track scheduled items here instead of filter() later
            scheduledItemsForAdaptive.push(scheduledItem);
            existingTimeStrs.add(timeStr);
          } else {
            const slotMinutes = hour * 60 + minute;
            if (!isMinuteOverlapped(slotMinutes)) {
              items.push({
                type: "ghost",
                order: order,
                note: undefined,
                timeStr: timeStr,
                displayTime: formatTimeAMPMCache(hour, minute),
                showGhost: true,
                showUnscheduled: false,
                showScheduled: false,
              });
              existingTimeStrs.add(timeStr);
            }
          }
        }

        // Add adaptive ghost slots
        // OPTIMIZATION v11: Use pre-collected scheduledItemsForAdaptive instead of filter()
        for (const scheduledItem of scheduledItemsForAdaptive) {
          const note = scheduledItem.note;
          if (!note) continue;

          const [h, m] = scheduledItem.timeStr.split(":").map(Number);
          const startMinutes = h * 60 + m;
          const noteDuration = note.duration
            ? parseInt(note.duration, 10)
            : timeInterval;
          const endMinutes = startMinutes + noteDuration;

          const nextBoundaryMinutes = Math.ceil(endMinutes / timeInterval) *
            timeInterval;
          const gapDuration = nextBoundaryMinutes - endMinutes;

          if (gapDuration > 0) {
            const ghostHour = Math.floor(endMinutes / 60);
            const ghostMinute = endMinutes % 60;
            const ghostTimeStr = `${String(ghostHour).padStart(2, "0")}:${
              String(ghostMinute).padStart(2, "0")
            }`;

            if (
              !existingTimeStrs.has(ghostTimeStr) &&
              !doesRangeOverlap(endMinutes, nextBoundaryMinutes)
            ) {
              items.push({
                type: "ghost",
                order: ghostHour * 100 + ghostMinute,
                note: undefined,
                timeStr: ghostTimeStr,
                displayTime: formatTimeAMPMCache(ghostHour, ghostMinute),
                showGhost: true,
                showUnscheduled: false,
                showScheduled: false,
                adaptiveDuration: gapDuration,
              });
              existingTimeStrs.add(ghostTimeStr);
            }
          }
        }

        items.sort((a, b) => a.order - b.order);
        return items;
      },
    );

    // Create the handler closure once at the pattern level
    const selectDayHandler = selectDayFromCalendar({
      currentDate,
      viewedYearMonth,
    });

    // OPTIMIZATION: Pre-compute a Record of dates that have entries for O(1) lookup
    // Using Record<string, true> instead of Set because Sets don't serialize through derive()
    const datesWithEntries = derive(
      mergedEntries,
      (mergedEntries: DayEntry[]) => {
        const dateMap: Record<string, true> = {};
        for (const entry of mergedEntries) {
          if (entry.notes && entry.notes.length > 0) {
            dateMap[entry.date] = true;
          }
        }
        return dateMap;
      },
    );

    // OPTIMIZATION v507: Split calendar grid from state for faster month navigation
    // Grid structure only depends on year-month, not selected day or entries

    // Step 1: Pure calendar grid structure - uses Zeller's congruence and pure math
    // OPTIMIZATION v508: Depends on viewedYearMonth, not currentDate
    // Only recomputes when month view changes, not when day selection changes
    const calendarGridStructure = derive(
      viewedYearMonth,
      (yearMonth: string) => {
        const [year, month] = yearMonth.split("-").map(Number);
        const monthIndex = month - 1; // Convert to 0-indexed

        // OPTIMIZATION v507: Use pure math instead of Date objects
        const firstDayOfWeek = getFirstDayOfWeek(year, monthIndex);
        const daysInMonth = getDaysInMonth(year, monthIndex);

        // Calculate how many weeks we need
        const totalDaysNeeded = firstDayOfWeek + daysInMonth;
        const weeksNeeded = Math.ceil(totalDaysNeeded / 7);
        const totalCells = weeksNeeded * 7;

        // Create array of day objects with date strings only
        const days: Array<{
          date: string;
          day: string;
          isEmpty: boolean;
          isOtherMonth: boolean;
        }> = [];

        // Add days from previous month
        if (firstDayOfWeek > 0) {
          const prevMonth = monthIndex === 0 ? 11 : monthIndex - 1;
          const prevYear = monthIndex === 0 ? year - 1 : year;
          const prevMonthLastDay = getDaysInMonth(prevYear, prevMonth);

          for (let i = firstDayOfWeek - 1; i >= 0; i--) {
            const day = prevMonthLastDay - i;
            // OPTIMIZATION v507: Use formatISODate instead of Date objects
            const dayDate = formatISODate(prevYear, prevMonth, day);
            days.push({
              date: dayDate,
              day: day.toString(),
              isEmpty: false,
              isOtherMonth: true,
            });
          }
        }

        // Add days of the current month
        for (let day = 1; day <= daysInMonth; day++) {
          const dayDate = formatISODate(year, monthIndex, day);
          days.push({
            date: dayDate,
            day: day.toString(),
            isEmpty: false,
            isOtherMonth: false,
          });
        }

        // Add days from next month to complete the final week
        const remainingCells = totalCells - days.length;
        if (remainingCells > 0) {
          const nextMonth = monthIndex === 11 ? 0 : monthIndex + 1;
          const nextYear = monthIndex === 11 ? year + 1 : year;

          for (let day = 1; day <= remainingCells; day++) {
            const dayDate = formatISODate(nextYear, nextMonth, day);
            days.push({
              date: dayDate,
              day: day.toString(),
              isEmpty: false,
              isOtherMonth: true,
            });
          }
        }

        return days;
      },
    );

    // Step 2: Merge grid structure with dynamic state (selection, entries, today)
    // OPTIMIZATION v508: Pre-compute className to avoid JSX ternary operations
    const calendarDays = derive(
      { calendarGridStructure, currentDate, datesWithEntries },
      ({ calendarGridStructure, currentDate, datesWithEntries }: {
        calendarGridStructure: Array<{
          date: string;
          day: string;
          isEmpty: boolean;
          isOtherMonth: boolean;
        }>;
        currentDate: string;
        datesWithEntries: Record<string, true>;
      }) => {
        const today = getTodayISO();

        return calendarGridStructure.map((dayObj) => {
          const hasEntry = !!datesWithEntries[dayObj.date];
          const isSelected = dayObj.date === currentDate;
          const isToday = dayObj.date === today;
          const isPast = dayObj.date < today;

          // OPTIMIZATION v508: Pre-compute className
          const classes = ["calendar-day"];
          if (dayObj.isEmpty) classes.push("empty");
          if (isSelected) classes.push("selected");
          if (hasEntry) classes.push("has-entry");
          if (isToday) classes.push("today");
          if (isPast) classes.push("past");
          if (dayObj.isOtherMonth) classes.push("other-month");

          return {
            ...dayObj,
            hasEntry,
            isSelected,
            isToday,
            isPast,
            className: classes.join(" "),
          };
        });
      },
    );

    // OPTIMIZATION v508: Use consolidated currentDateParsed instead of creating new Date objects
    // These derivations provide backward compatibility with existing UI references
    const currentMonth = derive(
      currentDateParsed,
      (parsed: any) => parsed.monthName,
    );
    const currentYear = derive(currentDateParsed, (parsed: any) => parsed.year);

    // Month items (0-11)
    const _monthItems = [
      { value: 0, label: "January" },
      { value: 1, label: "February" },
      { value: 2, label: "March" },
      { value: 3, label: "April" },
      { value: 4, label: "May" },
      { value: 5, label: "June" },
      { value: 6, label: "July" },
      { value: 7, label: "August" },
      { value: 8, label: "September" },
      { value: 9, label: "October" },
      { value: 10, label: "November" },
      { value: 11, label: "December" },
    ];

    // Hour items (01-12 for 12-hour format)
    const hourItems = [{ value: "--", label: "--" }];
    for (let i = 1; i <= 12; i++) {
      const hourStr = i.toString().padStart(2, "0");
      hourItems.push({ value: hourStr, label: hourStr });
    }

    // Minute items (15-minute intervals)
    const minuteItems = [
      { value: "--", label: "--" },
      { value: "00", label: "00" },
      { value: "15", label: "15" },
      { value: "30", label: "30" },
      { value: "45", label: "45" },
    ];

    // Period items (AM/PM)
    const periodItems = [
      { value: "--", label: "--" },
      { value: "AM", label: "AM" },
      { value: "PM", label: "PM" },
    ];

    // Settings interval items
    const intervalSelectItems = [
      { value: 60, label: "1 hour" },
      { value: 30, label: "30 minutes" },
    ];

    // OPTIMIZATION v508: Use pre-computed yearItems from currentDateParsed
    const _yearItems = derive(
      currentDateParsed,
      (parsed: any) => parsed.yearItems,
    );

    // OPTIMIZATION v508: Use pre-computed monthIndex from currentDateParsed
    const _currentMonthIndex = derive(
      currentDateParsed,
      (parsed: any) => parsed.monthIndex,
    );

    // Handler for date picker input (used on small screens)
    const handleDateInputChange = handler<
      { target: { value: string } },
      { currentDate: Writable<string> }
    >(({ target }, { currentDate }) => {
      const value = target.value;
      if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        currentDate.set(value);
      }
    });

    // Handler to add a new note to any date (exposed for external use)
    const addEntryHandler = handler<
      { date: string; text: string },
      {
        entries: Writable<DayEntry[]>;
        customTimeLabels: Writable<TimeLabel[]>;
        recurringSeries: Writable<RecurringSeries[]>;
      }
    >(({ date, text }, { entries, customTimeLabels, recurringSeries }) => {
      const trimmedText = (text || "").trim();
      if (!trimmedText) return;

      const configuredCustomTimeLabels = customTimeLabels.get();

      // FIRST: Check for recurrence patterns
      const recurrencePattern = parseRecurrencePattern(trimmedText, date);
      if (recurrencePattern && !recurrencePattern.isAmbiguous) {
        // Create a recurring series
        const seriesId = `series_${Date.now()}`;
        const cleanedForTime = recurrencePattern.cleanedText;

        // Parse time/notifications from cleaned text
        const parseResult = parseTimeFromText(
          cleanedForTime,
          configuredCustomTimeLabels,
        );
        const notifResult = parseNotifications(cleanedForTime);

        let rrule = "";
        if (recurrencePattern.frequency === "daily") {
          rrule = `FREQ=DAILY${
            recurrencePattern.interval
              ? `;INTERVAL=${recurrencePattern.interval}`
              : ""
          }`;
        } else if (recurrencePattern.frequency === "weekly") {
          const days = recurrencePattern.days || [];
          rrule = `FREQ=WEEKLY${
            days.length > 0 ? `;BYDAY=${days.join(",")}` : ""
          }${
            recurrencePattern.interval
              ? `;INTERVAL=${recurrencePattern.interval}`
              : ""
          }`;
        } else if (recurrencePattern.frequency === "monthly") {
          // For monthly, we'll use simple FREQ=MONTHLY for now
          // NOTE: BYMONTHDAY and BYDAY for monthly patterns not yet implemented
          rrule = `FREQ=MONTHLY${
            recurrencePattern.interval
              ? `;INTERVAL=${recurrencePattern.interval}`
              : ""
          }`;
        }

        const newSeries: RecurringSeries = {
          seriesId,
          text: parseResult?.cleanedText || cleanedForTime,
          rrule,
          dtstart: date,
          scheduledTime: parseResult?.time,
          duration: parseResult?.duration,
          notificationEnabled: notifResult?.enabled,
          notificationValue: notifResult?.value,
          notificationUnit: notifResult?.unit,
        };

        const allSeries = recurringSeries.get();
        recurringSeries.set([...allSeries, newSeries]);
        return;
      }

      // If ambiguous, show confirmation dialog (for now, treat as one-time)
      if (recurrencePattern?.isAmbiguous) {
        // NOTE: Ambiguity dialog not yet implemented
      }

      // Parse the text through NLP to extract times, notifications, etc.
      const events = parseMultipleEvents(
        trimmedText,
        configuredCustomTimeLabels,
      );

      if (events.length === 0) return;

      const allEntries = entries.get();
      const existingIndex = allEntries.findIndex((e: DayEntry) =>
        e.date === date
      );

      // Create notes with NLP-parsed data
      const newNotes: Note[] = events.map((event, idx) => {
        const noteId = `${Date.now()}-${idx}`;
        const note: Note = {
          id: noteId,
          text: event.text,
        };

        // Add time if parsed
        if (event.time) {
          note.scheduledTime = event.time;
        }

        // Add duration if parsed
        if (event.duration) {
          note.duration = event.duration;
        }

        // Add notification if parsed
        if (event.notification) {
          note.notificationEnabled = event.notification.enabled;
          note.notificationValue = event.notification.value;
          note.notificationUnit = event.notification.unit;
        }

        return note;
      });

      // External notes should not auto-edit
      // User can click to edit if needed

      if (existingIndex >= 0) {
        // Add notes to existing entry
        const updated = [...allEntries];
        const existingNotes = updated[existingIndex].notes || [];
        updated[existingIndex] = {
          date,
          notes: [...existingNotes, ...newNotes],
        };
        entries.set(updated);
      } else {
        // Create new entry with notes
        entries.set([...allEntries, { date, notes: newNotes }]);
      }
    });

    // Handler to update an existing note by ID (exposed for external use)
    const updateEntryHandler = handler<
      { date: string; noteId: string; text: string },
      { entries: Writable<DayEntry[]> }
    >(({ date, noteId, text }, { entries }) => {
      const trimmedText = (text || "").trim();

      const allEntries = entries.get();
      const existingIndex = allEntries.findIndex((e: DayEntry) =>
        e.date === date
      );

      if (existingIndex >= 0) {
        const updated = [...allEntries];
        const notes = updated[existingIndex].notes || [];
        const noteIndex = notes.findIndex((n: Note) => n.id === noteId);

        if (noteIndex >= 0) {
          // Update existing note - preserve all existing fields
          const existingNote = notes[noteIndex];
          const updatedNotes = [...notes];
          updatedNotes[noteIndex] = {
            ...existingNote,
            text: trimmedText,
          };
          updated[existingIndex] = { date, notes: updatedNotes };
          entries.set(updated);
        }
        // If noteId not found, do nothing (could optionally add as new note)
      }
      // If date not found, do nothing (could optionally create new entry)
    });

    // Handler to navigate to a specific date (exposed for external use)
    // OPTIMIZATION v508: Also update viewedYearMonth
    const goToDateHandler = handler<
      { date: string },
      { currentDate: Writable<string>; viewedYearMonth: Writable<string> }
    >(({ date }, { currentDate, viewedYearMonth }) => {
      // Validate date format (YYYY-MM-DD)
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        currentDate.set(date);
        viewedYearMonth.set(date.substring(0, 7));
      }
    });

    // Format the current date for display
    const formattedDate = derive(currentDate, (date: any) => {
      const d = new Date(date + "T00:00:00");
      return d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
    });

    // Filter out empty entries for display - unwrap notes to plain objects

    // Settings UI state
    const showSettings = Writable.of<boolean>(false);

    // Handler to toggle settings
    const toggleSettings = handler<never, { showSettings: Writable<boolean> }>(
      (_event, { showSettings }) => {
        showSettings.set(!showSettings.get());
      },
    );

    // Handler to close settings
    const closeSettings = handler<never, { showSettings: Writable<boolean> }>(
      (_event, { showSettings }) => {
        showSettings.set(false);
      },
    );

    // Handler to rename the calendar (exposed for external use)
    const renameHandler = handler<
      { name: string },
      { name: Writable<string> }
    >(({ name: newName }, { name }) => {
      if (newName && newName.trim().length > 0) {
        name.set(newName.trim());
      }
    });

    // Handler to set scheduled time for a note (exposed for external use)
    const setScheduledTimeHandler = handler<
      { date: string; noteId: string; scheduledTime?: string },
      {
        entries: Writable<DayEntry[]>;
        recurringSeries: Writable<RecurringSeries[]>;
        seriesOverrides: Writable<SeriesOverride[]>;
      }
    >((
      { date, noteId, scheduledTime },
      { entries, recurringSeries: _recurringSeries, seriesOverrides },
    ) => {
      const allEntries = entries.get();
      const existingIndex = allEntries.findIndex((e: DayEntry) =>
        e.date === date
      );

      if (existingIndex >= 0) {
        const notes = allEntries[existingIndex].notes || [];
        const noteIndex = notes.findIndex((n: Note) => n.id === noteId);

        if (noteIndex >= 0) {
          const note = notes[noteIndex];

          if (note.seriesId) {
            // For recurring events, create or update a SeriesOverride
            const allOverrides = seriesOverrides.get();
            const overrideIndex = allOverrides.findIndex(
              (o: SeriesOverride) =>
                o.seriesId === note.seriesId && o.recurrenceDate === date,
            );

            if (overrideIndex >= 0) {
              // Update existing override
              const updated = [...allOverrides];
              updated[overrideIndex] = {
                ...updated[overrideIndex],
                scheduledTime,
              };
              seriesOverrides.set(updated);
            } else {
              // Create new override
              seriesOverrides.set([
                ...allOverrides,
                {
                  seriesId: note.seriesId,
                  recurrenceDate: date,
                  scheduledTime,
                },
              ]);
            }
          } else {
            // For regular notes, update directly
            const updated = [...allEntries];
            const updatedNotes = [...notes];
            updatedNotes[noteIndex] = {
              ...note,
              scheduledTime,
            };
            updated[existingIndex] = { date, notes: updatedNotes };
            entries.set(updated);
          }
        }
      }
    });

    // Handler to set duration for a note (exposed for external use)
    const setDurationHandler = handler<
      { date: string; noteId: string; duration?: string },
      {
        entries: Writable<DayEntry[]>;
        seriesOverrides: Writable<SeriesOverride[]>;
      }
    >(({ date, noteId, duration }, { entries, seriesOverrides }) => {
      const allEntries = entries.get();
      const existingIndex = allEntries.findIndex((e: DayEntry) =>
        e.date === date
      );

      if (existingIndex >= 0) {
        const notes = allEntries[existingIndex].notes || [];
        const noteIndex = notes.findIndex((n: Note) => n.id === noteId);

        if (noteIndex >= 0) {
          const note = notes[noteIndex];

          if (note.seriesId) {
            // For recurring events, create or update a SeriesOverride
            const allOverrides = seriesOverrides.get();
            const overrideIndex = allOverrides.findIndex(
              (o: SeriesOverride) =>
                o.seriesId === note.seriesId && o.recurrenceDate === date,
            );

            if (overrideIndex >= 0) {
              // Update existing override
              const updated = [...allOverrides];
              updated[overrideIndex] = {
                ...updated[overrideIndex],
                duration,
              };
              seriesOverrides.set(updated);
            } else {
              // Create new override
              seriesOverrides.set([
                ...allOverrides,
                {
                  seriesId: note.seriesId,
                  recurrenceDate: date,
                  duration,
                },
              ]);
            }
          } else {
            // For regular notes, update directly
            const updated = [...allEntries];
            const updatedNotes = [...notes];
            updatedNotes[noteIndex] = {
              ...note,
              duration,
            };
            updated[existingIndex] = { date, notes: updatedNotes };
            entries.set(updated);
          }
        }
      }
    });

    // Handler to set notification settings for a note (exposed for external use)
    const setNotificationHandler = handler<
      {
        date: string;
        noteId: string;
        enabled: boolean;
        value?: number;
        unit?: "minute" | "hour" | "day" | "week";
      },
      {
        entries: Writable<DayEntry[]>;
        seriesOverrides: Writable<SeriesOverride[]>;
      }
    >((
      { date, noteId, enabled, value, unit },
      { entries, seriesOverrides },
    ) => {
      const allEntries = entries.get();
      const existingIndex = allEntries.findIndex((e: DayEntry) =>
        e.date === date
      );

      if (existingIndex >= 0) {
        const notes = allEntries[existingIndex].notes || [];
        const noteIndex = notes.findIndex((n: Note) => n.id === noteId);

        if (noteIndex >= 0) {
          const note = notes[noteIndex];

          if (note.seriesId) {
            // For recurring events, create or update a SeriesOverride
            const allOverrides = seriesOverrides.get();
            const overrideIndex = allOverrides.findIndex(
              (o: SeriesOverride) =>
                o.seriesId === note.seriesId && o.recurrenceDate === date,
            );

            if (overrideIndex >= 0) {
              // Update existing override
              const updated = [...allOverrides];
              updated[overrideIndex] = {
                ...updated[overrideIndex],
                notificationEnabled: enabled,
                notificationValue: value,
                notificationUnit: unit,
              };
              seriesOverrides.set(updated);
            } else {
              // Create new override
              seriesOverrides.set([
                ...allOverrides,
                {
                  seriesId: note.seriesId,
                  recurrenceDate: date,
                  notificationEnabled: enabled,
                  notificationValue: value,
                  notificationUnit: unit,
                },
              ]);
            }
          } else {
            // For regular notes, update directly
            const updated = [...allEntries];
            const updatedNotes = [...notes];
            updatedNotes[noteIndex] = {
              ...note,
              notificationEnabled: enabled,
              notificationValue: value,
              notificationUnit: unit,
            };
            updated[existingIndex] = { date, notes: updatedNotes };
            entries.set(updated);
          }
        }
      }
    });

    // Handler to create a new recurring series (exposed for external use)
    const createSeriesHandler = handler<
      {
        text: string;
        rrule: string;
        dtstart: string;
        scheduledTime?: string;
        duration?: string;
        notificationEnabled?: boolean;
        notificationValue?: number;
        notificationUnit?: "minute" | "hour" | "day" | "week";
        until?: string;
        count?: number;
      },
      { recurringSeries: Writable<RecurringSeries[]> }
    >((
      {
        text,
        rrule,
        dtstart,
        scheduledTime,
        duration,
        notificationEnabled,
        notificationValue,
        notificationUnit,
        until,
        count,
      },
      { recurringSeries },
    ) => {
      const seriesId = `series-${Date.now()}-${
        Math.random().toString(36).substring(2, 9)
      }`;

      const newSeries: RecurringSeries = {
        seriesId,
        text,
        rrule,
        dtstart,
        scheduledTime,
        duration,
        notificationEnabled,
        notificationValue,
        notificationUnit,
        until,
        count,
      };

      recurringSeries.set([...recurringSeries.get(), newSeries]);
    });

    // Handler to update an existing recurring series (exposed for external use)
    const updateSeriesHandler = handler<
      {
        seriesId: string;
        text?: string;
        rrule?: string;
        scheduledTime?: string;
        duration?: string;
        notificationEnabled?: boolean;
        notificationValue?: number;
        notificationUnit?: "minute" | "hour" | "day" | "week";
        until?: string;
        count?: number;
      },
      { recurringSeries: Writable<RecurringSeries[]> }
    >((
      {
        seriesId,
        text,
        rrule,
        scheduledTime,
        duration,
        notificationEnabled,
        notificationValue,
        notificationUnit,
        until,
        count,
      },
      { recurringSeries },
    ) => {
      const allSeries = recurringSeries.get();
      const seriesIndex = allSeries.findIndex((s: RecurringSeries) =>
        s.seriesId === seriesId
      );

      if (seriesIndex >= 0) {
        const updated = [...allSeries];
        const existingSeries = updated[seriesIndex];

        // Update only the fields that are provided
        updated[seriesIndex] = {
          ...existingSeries,
          ...(text !== undefined && { text }),
          ...(rrule !== undefined && { rrule }),
          ...(scheduledTime !== undefined && { scheduledTime }),
          ...(duration !== undefined && { duration }),
          ...(notificationEnabled !== undefined && { notificationEnabled }),
          ...(notificationValue !== undefined && { notificationValue }),
          ...(notificationUnit !== undefined && { notificationUnit }),
          ...(until !== undefined && { until }),
          ...(count !== undefined && { count }),
        };

        recurringSeries.set(updated);
      }
    });

    // Handler to delete a recurring series (exposed for external use)
    const deleteSeriesHandler = handler<
      { seriesId: string },
      { recurringSeries: Writable<RecurringSeries[]> }
    >(({ seriesId }, { recurringSeries }) => {
      const allSeries = recurringSeries.get();
      const filtered = allSeries.filter((s: RecurringSeries) =>
        s.seriesId !== seriesId
      );

      if (filtered.length < allSeries.length) {
        recurringSeries.set(filtered);
      }
    });

    // Handler to update name from settings input
    const updateName = handler<
      { detail: { message: string } },
      { name: Writable<string>; showSettings: Writable<boolean> }
    >(({ detail }, { name, showSettings }) => {
      const newName = detail?.message?.trim();
      if (newName && newName.length > 0) {
        name.set(newName);
        showSettings.set(false);
      }
    });

    // Handlers for managing custom time labels
    const addTimeLabel = handler<
      never,
      { customTimeLabels: Writable<TimeLabel[]> }
    >((_event, { customTimeLabels }) => {
      const labels = customTimeLabels.get();
      customTimeLabels.set([...labels, { label: "", time: "09:00" }]);
    });

    const updateTimeLabel = handler<
      { target: { value: string } },
      {
        customTimeLabels: Writable<TimeLabel[]>;
        index: number;
        field: "label" | "time";
      }
    >(({ target }, { customTimeLabels, index, field }) => {
      const labels = customTimeLabels.get();
      const updated = [...labels];
      updated[index] = { ...updated[index], [field]: target.value };
      customTimeLabels.set(updated);
    });

    const deleteTimeLabel = handler<
      never,
      { customTimeLabels: Writable<TimeLabel[]>; index: number }
    >((_event, { customTimeLabels, index }) => {
      const labels = customTimeLabels.get();
      const updated = labels.filter((_label, i) => i !== index);
      customTimeLabels.set(updated);
    });

    // Handlers for time grid settings
    const _updateStartTime = handler<
      { target: { value: string } },
      { startTime: Writable<number> }
    >(({ target }, { startTime }) => {
      startTime.set(parseInt(target.value, 10));
    });

    const _updateEndTime = handler<
      { target: { value: string } },
      { endTime: Writable<number> }
    >(({ target }, { endTime }) => {
      endTime.set(parseInt(target.value, 10));
    });

    const _updateTimeInterval = handler<
      { target: { value: string } },
      { timeInterval: Writable<30 | 60> }
    >(({ target }, { timeInterval }) => {
      timeInterval.set(parseInt(target.value, 10) as 30 | 60);
    });

    // Schedule modal state
    const scheduleModalState = Writable.of<
      { noteId: string; date: string } | null
    >(
      null,
    );

    // Track which note is being edited inline (empty string = none)
    const _editingNoteId = Writable.of<string>("");

    // Track if this is a new event (text was empty when modal opened)
    const isNewEventCell = Writable.of<boolean>(false);

    // Schedule form cells (for modal editing)
    const scheduleTimeCell = Writable.of<string>("");
    const scheduleTextCell = Writable.of<string>(""); // Note text in modal
    const scheduleStartDateCell = Writable.of<string>(""); // Start date for the event
    const scheduleHourCell = Writable.of<string>("12");
    const scheduleMinuteCell = Writable.of<string>("00");
    const schedulePeriodCell = Writable.of<string>("AM");
    const scheduleDurationCell = Writable.of<string>("none"); // Duration selector
    const scheduleNotifEnabledCell = Writable.of<boolean>(false);
    const scheduleNotifValueCell = Writable.of<number>(1);
    const scheduleNotifUnitCell = Writable.of<string>("minute");

    // Recurring event cells
    const scheduleRepeatCell = Writable.of<string>("none"); // 'none', 'daily', 'weekly', 'monthly'
    const scheduleRepeatDaysCell = Writable.of<string[]>([]); // ['MO', 'WE', 'FR']
    const scheduleMonthlyPatternCell = Writable.of<string>("dayOfMonth"); // 'dayOfMonth' (e.g., 15th) or 'weekdayOfMonth' (e.g., first Friday)
    const scheduleRepeatEndsCell = Writable.of<string>("never"); // 'never', 'on', 'after'
    const scheduleRepeatUntilCell = Writable.of<string>(""); // ISO date for 'on'
    const scheduleRepeatCountCell = Writable.of<number>(10); // count for 'after'
    const scheduleEditScopeCell = Writable.of<string>("all"); // 'this', 'future', 'all' - scope of changes when editing recurring event
    const scheduleConfirmingScopeCell = Writable.of<boolean>(false); // True when showing scope confirmation after Save clicked
    const scheduleOriginalWeeklyDaysCell = Writable.of<string[]>([]); // Tracks original BYDAY values when opening a weekly recurring event
    const deletionConfirmingScopeCell = Writable.of<boolean>(false); // True when showing scope confirmation for deletion
    const deletionPendingCell = Writable.of<
      { noteId: string; date: string } | null
    >(
      null,
    ); // Pending deletion info

    // Derived cell to check if weekly days have changed (to hide "All events in series" option)
    const weeklyDaysHaveChanged = derive(
      {
        scheduleRepeatCell,
        scheduleRepeatDaysCell,
        scheduleOriginalWeeklyDaysCell,
        scheduleModalState,
      },
      (
        {
          scheduleRepeatCell,
          scheduleRepeatDaysCell,
          scheduleOriginalWeeklyDaysCell,
          scheduleModalState,
        }: any,
      ) => {
        // Only relevant if we're editing a recurring event and it's weekly
        if (
          !scheduleModalState || !scheduleModalState.noteId ||
          !scheduleModalState.noteId.includes(":")
        ) {
          return false; // Not a recurring event
        }
        if (scheduleRepeatCell !== "weekly") {
          return false; // Not a weekly event
        }
        // Check if days have changed
        const original = scheduleOriginalWeeklyDaysCell;
        const current = scheduleRepeatDaysCell;
        if (original.length !== current.length) {
          return true;
        }
        const originalSorted = [...original].sort();
        const currentSorted = [...current].sort();
        return !originalSorted.every((day, i) => day === currentSorted[i]);
      },
    );

    // Recurrence ambiguity confirmation (for patterns like "Monday meeting")
    const _recurrenceAmbiguityCell = Writable.of<boolean>(false); // True when showing ambiguity dialog
    const _recurrencePendingCell = Writable.of<
      {
        text: string;
        date: string;
        pattern: { frequency: string; days?: string[]; cleanedText: string };
      } | null
    >(null); // Pending recurrence info awaiting user decision

    // Auto-select day of week when weekly recurrence is selected with no days
    derive(
      { repeat: scheduleRepeatCell, startDate: scheduleStartDateCell },
      ({ repeat, startDate }: any) => {
        // If weekly is selected and no days are chosen, auto-select the day matching start date
        const currentDays = scheduleRepeatDaysCell.get();
        if (repeat === "weekly" && currentDays.length === 0 && startDate) {
          const date = new Date(startDate + "T00:00:00");
          const dayOfWeek = date.getDay();
          const dayMap = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
          const dayCode = dayMap[dayOfWeek];
          scheduleRepeatDaysCell.set([dayCode]);
        }
      },
    );

    // Derive the time from hour and minute cells
    const _combinedTime = derive(
      { scheduleHourCell, scheduleMinuteCell },
      ({ scheduleHourCell, scheduleMinuteCell }: any) => {
        return `${scheduleHourCell}:${scheduleMinuteCell}`;
      },
    );

    // Helper function to calculate end time from start time and duration
    const calculateEndTime = (
      startHour: string,
      startMinute: string,
      startPeriod: string,
      durationMinutes: number,
    ): string => {
      // Convert to 24-hour format
      let hour24 = parseInt(startHour);
      if (startPeriod === "PM" && hour24 !== 12) hour24 += 12;
      if (startPeriod === "AM" && hour24 === 12) hour24 = 0;

      const totalMinutes = hour24 * 60 + parseInt(startMinute) +
        durationMinutes;
      const endHour24 = Math.floor(totalMinutes / 60) % 24;
      const endMinute = totalMinutes % 60;

      // Convert back to 12-hour format
      const endPeriod = endHour24 >= 12 ? "PM" : "AM";
      const endHour12 = endHour24 % 12 || 12;

      return `${endHour12}:${
        endMinute.toString().padStart(2, "0")
      } ${endPeriod}`;
    };

    // Derive duration items with end times
    const durationItems = derive(
      { scheduleHourCell, scheduleMinuteCell, schedulePeriodCell },
      ({ scheduleHourCell, scheduleMinuteCell, schedulePeriodCell }: any) => {
        const durations = [
          { minutes: 0, label: "No duration" },
          { minutes: 15, label: "15 minutes" },
          { minutes: 30, label: "30 minutes" },
          { minutes: 45, label: "45 minutes" },
          { minutes: 60, label: "1 hour" },
          { minutes: 90, label: "1.5 hours" },
          { minutes: 120, label: "2 hours" },
          { minutes: 180, label: "3 hours" },
          { minutes: 240, label: "4 hours" },
          { minutes: 300, label: "5 hours" },
          { minutes: 360, label: "6 hours" },
          { minutes: 420, label: "7 hours" },
          { minutes: 480, label: "8 hours" },
          { minutes: 540, label: "9 hours" },
          { minutes: 600, label: "10 hours" },
          { minutes: 660, label: "11 hours" },
          { minutes: 720, label: "12 hours" },
        ];

        return durations.map((d) => {
          if (d.minutes === 0) {
            return { value: "none", label: d.label };
          }
          const endTime = calculateEndTime(
            scheduleHourCell,
            scheduleMinuteCell,
            schedulePeriodCell,
            d.minutes,
          );
          return {
            value: d.minutes.toString(),
            label: `${d.label} (${endTime})`,
          };
        });
      },
    );

    // Handler to toggle a day of the week for weekly recurrence
    const toggleRepeatDay = handler<
      never,
      { day: string; scheduleRepeatDaysCell: Writable<string[]> }
    >((_event, { day, scheduleRepeatDaysCell }) => {
      const days = scheduleRepeatDaysCell.get();
      if (days.includes(day)) {
        scheduleRepeatDaysCell.set(days.filter((d) => d !== day));
      } else {
        scheduleRepeatDaysCell.set([...days, day]);
      }
    });

    // Handler for when repeat type changes - auto-selects day for Weekly
    // Note: $value binding handles updating scheduleRepeatCell automatically
    const onRepeatTypeChange = handler<
      { detail: { value: string } },
      {
        scheduleRepeatDaysCell: Writable<string[]>;
        scheduleStartDateCell: Writable<string>;
      }
    >(({ detail }, { scheduleRepeatDaysCell, scheduleStartDateCell }) => {
      const newValue = detail?.value || "none";

      if (newValue === "weekly") {
        // Get the start date and calculate day of week
        const startDate = scheduleStartDateCell.get();
        if (startDate) {
          const date = new Date(startDate + "T00:00:00"); // Ensure local timezone
          const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
          const dayMap = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
          const selectedDay = dayMap[dayOfWeek];
          scheduleRepeatDaysCell.set([selectedDay]);
        }
      }
    });

    // Handler to open schedule modal
    const openScheduleModal = handler<
      never,
      {
        scheduleModalState: Writable<{ noteId: string; date: string } | null>;
        noteId: string;
        currentDate: Writable<string>;
        entries: Writable<DayEntry[]>;
        recurringSeries: Writable<RecurringSeries[]>;
        scheduleTimeCell: Writable<string>;
        scheduleTextCell: Writable<string>;
        scheduleStartDateCell: Writable<string>;
        scheduleHourCell: Writable<string>;
        scheduleMinuteCell: Writable<string>;
        schedulePeriodCell: Writable<string>;
        scheduleDurationCell: Writable<string>;
        scheduleNotifEnabledCell: Writable<boolean>;
        scheduleNotifValueCell: Writable<number>;
        scheduleNotifUnitCell: Writable<string>;
        scheduleRepeatCell: Writable<string>;
        scheduleRepeatDaysCell: Writable<string[]>;
        scheduleRepeatEndsCell: Writable<string>;
        scheduleRepeatUntilCell: Writable<string>;
        scheduleRepeatCountCell: Writable<number>;
        scheduleEditScopeCell: Writable<string>;
        scheduleConfirmingScopeCell: Writable<boolean>;
        scheduleOriginalWeeklyDaysCell: Writable<string[]>;
        isNewEventCell: Writable<boolean>;
      }
    >((_event, {
      scheduleModalState,
      noteId,
      currentDate,
      entries,
      recurringSeries,
      scheduleTimeCell,
      scheduleTextCell,
      scheduleStartDateCell,
      scheduleHourCell,
      scheduleMinuteCell,
      schedulePeriodCell,
      scheduleDurationCell,
      scheduleNotifEnabledCell,
      scheduleNotifValueCell,
      scheduleNotifUnitCell,
      scheduleRepeatCell,
      scheduleRepeatDaysCell,
      scheduleRepeatEndsCell,
      scheduleRepeatUntilCell,
      scheduleRepeatCountCell,
      scheduleEditScopeCell,
      scheduleConfirmingScopeCell,
      scheduleOriginalWeeklyDaysCell,
      isNewEventCell,
    }) => {
      const date = currentDate.get();

      // Set the start date to current date by default
      scheduleStartDateCell.set(date);

      // Default edit scope to 'all'
      scheduleEditScopeCell.set("all");

      // Reset confirmation state
      scheduleConfirmingScopeCell.set(false);

      // Check if this is a recurring occurrence (noteId format: "seriesId:date")
      let note: Note | undefined;
      let _seriesIdFromNote: string | undefined;

      if (noteId.includes(":")) {
        // This is a recurring occurrence
        const [seriesId, _occurrenceDate] = noteId.split(":");
        _seriesIdFromNote = seriesId;

        // Find the series to get the note data
        const allSeries = recurringSeries.get();
        const series = allSeries.find((s: RecurringSeries) =>
          s.seriesId === seriesId
        );

        if (series) {
          // Create a note-like object from the series
          note = {
            id: noteId,
            text: series.text,
            scheduledTime: series.scheduledTime,
            duration: series.duration,
            notificationEnabled: series.notificationEnabled,
            notificationValue: series.notificationValue,
            notificationUnit: series.notificationUnit,
            seriesId: seriesId,
          };
        }
      } else {
        // This is a one-off note
        const allEntries = entries.get();
        const entry = allEntries.find((e: DayEntry) => e.date === date);
        note = entry?.notes?.find((n: Note) => n.id === noteId);
      }

      if (note) {
        // Load note text
        const noteText = note.text || "";
        scheduleTextCell.set(noteText);

        // Track if this is a new event (text is empty)
        isNewEventCell.set(noteText.trim() === "");

        // Populate form cells with current note values (only if time exists)
        if (note.scheduledTime) {
          const time = note.scheduledTime;
          scheduleTimeCell.set(time);
          // Parse time to hour and minute (time is in 24-hour format HH:MM)
          const [hour24Str, minute] = time.split(":");
          const hour24 = parseInt(hour24Str || "12", 10);

          // Convert to 12-hour format
          let hour12 = hour24 % 12;
          if (hour12 === 0) hour12 = 12;
          const period = hour24 >= 12 ? "PM" : "AM";

          scheduleHourCell.set(hour12.toString().padStart(2, "0"));
          schedulePeriodCell.set(period);

          // Round minute to nearest 15-minute interval
          const minuteNum = parseInt(minute || "0", 10);
          const roundedMinute = Math.round(minuteNum / 15) * 15;
          const minuteStr = roundedMinute.toString().padStart(2, "0");
          scheduleMinuteCell.set(minuteStr === "60" ? "00" : minuteStr);
          if (minuteStr === "60") {
            // If rounding goes to 60, increment hour
            let newHour12 = hour12 + 1;
            let newPeriod = period;
            if (newHour12 > 12) {
              newHour12 = 1;
              newPeriod = period === "AM" ? "PM" : "AM";
            }
            scheduleHourCell.set(newHour12.toString().padStart(2, "0"));
            schedulePeriodCell.set(newPeriod);
          }
        } else {
          // No time set - reset to defaults to indicate unscheduled
          scheduleHourCell.set("--");
          scheduleMinuteCell.set("--");
          schedulePeriodCell.set("--");
        }

        // Load duration from note
        const loadedDuration = note.duration || "none";
        scheduleDurationCell.set(loadedDuration);

        scheduleNotifEnabledCell.set(note.notificationEnabled || false);
        scheduleNotifValueCell.set(note.notificationValue || 1);
        scheduleNotifUnitCell.set(note.notificationUnit || "minute");
      }

      // Check if this is a recurring event occurrence
      if (note?.seriesId) {
        // This is a recurring event - load the series settings
        const allSeries = recurringSeries.get();
        const series = allSeries.find((s: RecurringSeries) =>
          s.seriesId === note.seriesId
        );

        if (series) {
          // Parse rrule to determine repeat type and extract parameters
          const rruleParts: Record<string, string> = {};
          series.rrule.split(";").forEach((part) => {
            const [key, value] = part.split("=");
            rruleParts[key] = value;
          });

          if (series.rrule.includes("FREQ=DAILY")) {
            scheduleRepeatCell.set("daily");
            scheduleRepeatDaysCell.set([]);
          } else if (series.rrule.includes("FREQ=WEEKLY")) {
            scheduleRepeatCell.set("weekly");
            // Parse BYDAY if present
            const byday = rruleParts["BYDAY"];
            if (byday) {
              const days = byday.split(",");
              scheduleRepeatDaysCell.set(days);
              scheduleOriginalWeeklyDaysCell.set(days); // Store original days for comparison
            } else {
              scheduleRepeatDaysCell.set([]);
              scheduleOriginalWeeklyDaysCell.set([]);
            }
          } else {
            scheduleRepeatCell.set("none");
            scheduleRepeatDaysCell.set([]);
            scheduleOriginalWeeklyDaysCell.set([]); // Reset for non-weekly events
          }

          // Set ends options
          if (series.until) {
            scheduleRepeatEndsCell.set("on");
            scheduleRepeatUntilCell.set(series.until);
          } else {
            scheduleRepeatEndsCell.set("never");
          }

          console.log("[openScheduleModal] Loaded recurring settings:", {
            repeat: scheduleRepeatCell.get(),
            ends: scheduleRepeatEndsCell.get(),
            days: scheduleRepeatDaysCell.get(),
          });
        }
      } else {
        // Reset repeat options to defaults for one-off events
        scheduleRepeatCell.set("none");
        scheduleRepeatEndsCell.set("never");
        scheduleRepeatDaysCell.set([]);
        // Default "until" date to end of the month of the item being scheduled
        const itemDate = new Date(date + "T00:00:00");
        const endOfMonth = new Date(
          itemDate.getFullYear(),
          itemDate.getMonth() + 1,
          0,
        );
        const defaultUntil = `${endOfMonth.getFullYear()}-${
          String(endOfMonth.getMonth() + 1).padStart(2, "0")
        }-${String(endOfMonth.getDate()).padStart(2, "0")}`;
        scheduleRepeatUntilCell.set(defaultUntil);
        scheduleRepeatCountCell.set(10);
      }

      scheduleModalState.set({ noteId, date });
    });

    // Handler to close schedule modal
    const closeScheduleModal = handler<
      never,
      {
        scheduleModalState: Writable<{ noteId: string; date: string } | null>;
        isNewEventCell: Writable<boolean>;
      }
    >((_event, { scheduleModalState, isNewEventCell }) => {
      scheduleModalState.set(null);
      // Reset new event flag
      isNewEventCell.set(false);
    });

    // Handler for Note input change - auto-populate form fields from NLP (like inline notes)
    const onNoteChange = handler<
      { target: { value: string } },
      {
        scheduleTextCell: Writable<string>;
        scheduleHourCell: Writable<string>;
        scheduleMinuteCell: Writable<string>;
        schedulePeriodCell: Writable<string>;
        scheduleDurationCell: Writable<string>;
        scheduleNotifEnabledCell: Writable<boolean>;
        scheduleNotifValueCell: Writable<number>;
        scheduleNotifUnitCell: Writable<string>;
        scheduleRepeatCell: Writable<string>;
        scheduleRepeatDaysCell: Writable<string[]>;
        scheduleMonthlyPatternCell: Writable<string>;
        scheduleModalState: Writable<{ noteId: string; date: string } | null>;
        customTimeLabels: Writable<TimeLabel[]>;
      }
    >(({ target }, state) => {
      const text = target?.value ?? "";

      // Update the cell first
      state.scheduleTextCell.set(text);

      const trimmedText = text.trim();
      if (trimmedText.length === 0) return;

      const {
        scheduleTextCell,
        scheduleHourCell,
        scheduleMinuteCell,
        schedulePeriodCell,
        scheduleDurationCell,
        scheduleNotifEnabledCell: _scheduleNotifEnabledCell,
        scheduleNotifValueCell: _scheduleNotifValueCell,
        scheduleNotifUnitCell: _scheduleNotifUnitCell,
        scheduleRepeatCell,
        scheduleRepeatDaysCell,
        scheduleMonthlyPatternCell,
        scheduleModalState,
        customTimeLabels,
      } = state;

      const configuredCustomTimeLabels = customTimeLabels.get();

      const modalState = scheduleModalState.get();
      if (!modalState) return;

      const { date } = modalState;

      // Check for recurrence pattern first
      const recurrencePattern = parseRecurrencePattern(trimmedText, date);

      if (recurrencePattern && !recurrencePattern.isAmbiguous) {
        // Populate form fields instead of creating series immediately
        if (recurrencePattern.frequency === "daily") {
          scheduleRepeatCell.set("daily");
          scheduleRepeatDaysCell.set([]);
        } else if (recurrencePattern.frequency === "weekly") {
          scheduleRepeatCell.set("weekly");
          scheduleRepeatDaysCell.set(recurrencePattern.days || []);
        } else if (recurrencePattern.frequency === "monthly") {
          scheduleRepeatCell.set("monthly");
          scheduleRepeatDaysCell.set([]);
          if (recurrencePattern.monthlyPattern) {
            scheduleMonthlyPatternCell.set(
              recurrencePattern.monthlyPattern.type,
            );
          }
        }

        // Update text to cleaned version (with recurrence clause removed)
        scheduleTextCell.set(recurrencePattern.cleanedText);

        // Parse time from cleaned text
        const timeData = parseTimeFromText(
          recurrencePattern.cleanedText,
          configuredCustomTimeLabels,
        );
        if (timeData) {
          if (timeData.time) {
            const [hour24Str, minute] = timeData.time.split(":");
            const hour24 = parseInt(hour24Str, 10);

            let hour12 = hour24 % 12;
            if (hour12 === 0) hour12 = 12;
            const period = hour24 >= 12 ? "PM" : "AM";

            scheduleHourCell.set(hour12.toString().padStart(2, "0"));
            scheduleMinuteCell.set(minute);
            schedulePeriodCell.set(period);
          }

          if (timeData.duration) {
            scheduleDurationCell.set(timeData.duration);
          }

          // Update text again with time also removed
          scheduleTextCell.set(timeData.cleanedText);
        }

        return;
      }

      // No recurrence pattern - just parse time/duration like normal
      const timeData = parseTimeFromText(
        trimmedText,
        configuredCustomTimeLabels,
      );
      if (timeData) {
        if (timeData.time) {
          const [hour24Str, minute] = timeData.time.split(":");
          const hour24 = parseInt(hour24Str, 10);

          let hour12 = hour24 % 12;
          if (hour12 === 0) hour12 = 12;
          const period = hour24 >= 12 ? "PM" : "AM";

          scheduleHourCell.set(hour12.toString().padStart(2, "0"));
          scheduleMinuteCell.set(minute);
          schedulePeriodCell.set(period);
        }

        if (timeData.duration) {
          scheduleDurationCell.set(timeData.duration);
        }

        // Update text with time removed
        scheduleTextCell.set(timeData.cleanedText);
      }
    });

    // Handler to stop propagation (no-op, just prevents parent click)
    const _stopPropagation = handler<never, Record<string, never>>(
      (_event, _state) => {
        // Do nothing - this just stops the event from bubbling to parent
      },
    );

    // Handler to delete note from modal
    const deleteNoteFromModal = handler<
      never,
      {
        entries: Writable<DayEntry[]>;
        recurringSeries: Writable<RecurringSeries[]>;
        scheduleModalState: Writable<{ noteId: string; date: string } | null>;
        seriesOverrides: Writable<SeriesOverride[]>;
        deletionConfirmingScopeCell: Writable<boolean>;
        deletionPendingCell: Writable<{ noteId: string; date: string } | null>;
        scheduleEditScopeCell: Writable<string>;
      }
    >((
      _event,
      {
        entries,
        recurringSeries,
        scheduleModalState,
        seriesOverrides,
        deletionConfirmingScopeCell,
        deletionPendingCell,
        scheduleEditScopeCell,
      },
    ) => {
      const modalState = scheduleModalState.get();
      if (!modalState) return;

      const { noteId, date } = modalState;

      // Check if this is a recurring occurrence (noteId format: "seriesId:date")
      if (noteId.includes(":")) {
        // Check if we need to show confirmation dialog
        const isConfirming = deletionConfirmingScopeCell.get();

        if (!isConfirming) {
          // Close the schedule modal and show confirmation dialog
          scheduleModalState.set(null);
          deletionPendingCell.set({ noteId, date });
          deletionConfirmingScopeCell.set(true);
          return;
        }

        // User has confirmed - reset and proceed
        deletionConfirmingScopeCell.set(false);
        const deleteScope = scheduleEditScopeCell.get();
        performDeleteLogic({
          entries,
          recurringSeries,
          seriesOverrides,
          noteId,
          date,
          deleteScope,
        });
        deletionPendingCell.set(null);
        return;
      }

      // Otherwise, delete a one-off note from entries
      const allEntries = entries.get();
      const existingIndex = allEntries.findIndex((e: DayEntry) =>
        e.date === date
      );

      if (existingIndex >= 0) {
        const updated = [...allEntries];
        const notes = updated[existingIndex].notes || [];
        const filteredNotes = notes.filter((n: Note) => n.id !== noteId);

        if (filteredNotes.length > 0) {
          updated[existingIndex] = { date, notes: filteredNotes };
        } else {
          updated.splice(existingIndex, 1);
        }

        entries.set(updated);
        scheduleModalState.set(null);
      }
    });

    // Handler for magic wand - parse text to extract schedule info
    const _parseScheduleText = handler<
      never,
      {
        scheduleTextCell: Writable<string>;
        scheduleHourCell: Writable<string>;
        scheduleMinuteCell: Writable<string>;
        schedulePeriodCell: Writable<string>;
        scheduleDurationCell: Writable<string>;
        scheduleNotifEnabledCell: Writable<boolean>;
        scheduleNotifValueCell: Writable<number>;
        scheduleNotifUnitCell: Writable<string>;
        customTimeLabels: Writable<TimeLabel[]>;
      }
    >((_event, {
      scheduleTextCell,
      scheduleHourCell,
      scheduleMinuteCell,
      schedulePeriodCell,
      scheduleDurationCell,
      scheduleNotifEnabledCell,
      scheduleNotifValueCell,
      scheduleNotifUnitCell,
      customTimeLabels,
    }) => {
      const text = scheduleTextCell.get();
      const configuredCustomTimeLabels = customTimeLabels.get();

      // Parse time from text using existing function
      const parseResult = parseTimeFromText(text, configuredCustomTimeLabels);
      if (parseResult) {
        const { time, duration, cleanedText } = parseResult;

        // Parse time (HH:MM format)
        const [hour24Str, minute] = time.split(":");
        const hour24 = parseInt(hour24Str, 10);

        // Convert to 12-hour format
        let hour12 = hour24 % 12;
        if (hour12 === 0) hour12 = 12;
        const period = hour24 >= 12 ? "PM" : "AM";

        scheduleHourCell.set(hour12.toString().padStart(2, "0"));
        scheduleMinuteCell.set(minute);
        schedulePeriodCell.set(period);

        // Set duration if found
        if (duration) {
          scheduleDurationCell.set(duration);
        }

        // Update text to cleaned version (without time info)
        scheduleTextCell.set(cleanedText);
      }

      // Parse notification patterns - supports many formats
      const notifPatterns = [
        // Specific time before: "remind me 15 minutes before", "notify 1 hour before"
        /(?:remind|notify|don't\s+forget)(?:\s+me)?\s+(\d+)\s*(?:minute|min|m|hour|hr|h|day|d|week|w)s?\s+(?:before|early|ahead)/i,
        // Just time amount: "15 minute reminder", "1 hour notification"
        /(\d+)\s*(?:minute|min|m|hour|hr|h|day|d|week|w)s?\s+(?:reminder|notification|alert)/i,
        // Shorthand with unit: "remind 15m", "notify 1h"
        /(?:remind|notify|don't\s+forget)(?:\s+me)?\s+(\d+)\s*(m|h|d|w)\b/i,
        // Just "remind me" or "don't forget" - default to 0 minutes (at event time)
        /(?:remind|notify|don't\s+forget)(?:\s+me)?(?!\s+\d)/i,
      ];

      let cleanedNotifText = scheduleTextCell.get();

      for (let i = 0; i < notifPatterns.length; i++) {
        const match = cleanedNotifText.match(notifPatterns[i]);
        if (match) {
          let value = 0;
          let unit: "minute" | "hour" | "day" | "week" = "minute";

          if (i === 3) {
            // Just "remind me" or "don't forget" without time - set to 0 minutes
            value = 0;
            unit = "minute";
          } else {
            // Extract the number and unit
            value = parseInt(match[1], 10);
            const unitStr =
              (match[2] || match[1].match(/\s*([a-z]+)s?/i)?.[1] || "m")
                .toLowerCase();

            if (unitStr.startsWith("h")) unit = "hour";
            else if (unitStr.startsWith("d")) unit = "day";
            else if (unitStr.startsWith("w")) unit = "week";
            else unit = "minute";
          }

          scheduleNotifEnabledCell.set(true);
          scheduleNotifValueCell.set(value);
          scheduleNotifUnitCell.set(unit);

          // Remove the notification text from the note
          cleanedNotifText = cleanedNotifText.replace(match[0], "").trim();
          scheduleTextCell.set(cleanedNotifText);
          break;
        }
      }
    });

    // Handler for "I'm Feeling Lucky" - parse multiple events, save, and close modal
    const feelingLucky = handler<
      never,
      {
        entries: Writable<DayEntry[]>;
        recurringSeries: Writable<RecurringSeries[]>;
        scheduleModalState: Writable<{ noteId: string; date: string } | null>;
        scheduleTextCell: Writable<string>;
        scheduleHourCell: Writable<string>;
        scheduleMinuteCell: Writable<string>;
        schedulePeriodCell: Writable<string>;
        scheduleDurationCell: Writable<string>;
        scheduleNotifEnabledCell: Writable<boolean>;
        scheduleNotifValueCell: Writable<number>;
        scheduleNotifUnitCell: Writable<string>;
        customTimeLabels: Writable<TimeLabel[]>;
      }
    >((_event, {
      entries,
      recurringSeries,
      scheduleModalState,
      scheduleTextCell,
      scheduleHourCell,
      scheduleMinuteCell,
      schedulePeriodCell,
      scheduleDurationCell,
      scheduleNotifEnabledCell,
      scheduleNotifValueCell,
      scheduleNotifUnitCell,
      customTimeLabels,
    }) => {
      const text = scheduleTextCell.get();
      const configuredCustomTimeLabels = customTimeLabels.get();

      const modalState = scheduleModalState.get();
      if (!modalState) return;

      const { noteId, date } = modalState;

      // Check for recurrence pattern first
      const trimmedText = text.trim();
      const recurrencePattern = parseRecurrencePattern(trimmedText, date);

      if (recurrencePattern && !recurrencePattern.isAmbiguous) {
        // Create recurring series

        const seriesId = `series_${Date.now()}`;
        const allSeries = recurringSeries.get();

        // Build rrule based on frequency
        let rrule = "";
        if (recurrencePattern.frequency === "daily") {
          rrule = `FREQ=DAILY${
            recurrencePattern.interval
              ? `;INTERVAL=${recurrencePattern.interval}`
              : ""
          }`;
        } else if (recurrencePattern.frequency === "weekly") {
          const days = recurrencePattern.days || [];
          rrule = `FREQ=WEEKLY${
            days.length > 0 ? `;BYDAY=${days.join(",")}` : ""
          }${
            recurrencePattern.interval
              ? `;INTERVAL=${recurrencePattern.interval}`
              : ""
          }`;
        } else if (recurrencePattern.frequency === "monthly") {
          // NOTE: Monthly patterns with BYMONTHDAY or BYDAY not yet implemented
          rrule = `FREQ=MONTHLY${
            recurrencePattern.interval
              ? `;INTERVAL=${recurrencePattern.interval}`
              : ""
          }`;
        }

        // Parse time/notifications from the cleaned text
        const cleanedText = recurrencePattern.cleanedText;
        const timeData = parseTimeFromText(
          cleanedText,
          configuredCustomTimeLabels,
        );

        const newSeries: RecurringSeries = {
          seriesId,
          text: cleanedText,
          rrule,
          dtstart: date,
          scheduledTime: timeData?.time,
          duration: timeData?.duration,
          // Use current notification settings if enabled
          notificationEnabled: scheduleNotifEnabledCell.get(),
          notificationValue: scheduleNotifValueCell.get(),
          notificationUnit: scheduleNotifUnitCell.get() as
            | "minute"
            | "hour"
            | "day"
            | "week",
        };

        recurringSeries.set([...allSeries, newSeries]);

        // Remove the temporary note that was being edited
        const allEntries = entries.get();
        const existingIndex = allEntries.findIndex((e: DayEntry) =>
          e.date === date
        );
        if (existingIndex >= 0) {
          const updated = [...allEntries];
          const notes = updated[existingIndex].notes || [];
          const filteredNotes = notes.filter((n: Note) => n.id !== noteId);
          if (filteredNotes.length === 0) {
            updated.splice(existingIndex, 1);
          } else {
            updated[existingIndex] = { date, notes: filteredNotes };
          }
          entries.set(updated);
        }

        scheduleModalState.set(null);
        return;
      }

      // If ambiguous, TODO: show ambiguity dialog (for now, fall through to regular parsing)

      // Parse for multiple events with per-event notification support
      const events = parseMultipleEvents(text, configuredCustomTimeLabels);

      if (events.length === 0) {
        scheduleModalState.set(null);
        return;
      }

      const allEntries = entries.get();
      const existingIndex = allEntries.findIndex((e: DayEntry) =>
        e.date === date
      );

      if (events.length === 1) {
        // Single event - update the existing note with its notification if any
        const event = events[0];

        if (event.time) {
          const [hour24Str, minute] = event.time.split(":");
          const hour24 = parseInt(hour24Str, 10);

          let hour12 = hour24 % 12;
          if (hour12 === 0) hour12 = 12;
          const period = hour24 >= 12 ? "PM" : "AM";

          scheduleHourCell.set(hour12.toString().padStart(2, "0"));
          scheduleMinuteCell.set(minute);
          schedulePeriodCell.set(period);
        }

        if (event.duration) {
          scheduleDurationCell.set(event.duration);
        }

        scheduleTextCell.set(event.text);

        // Use event-specific notification settings
        if (event.notification) {
          scheduleNotifEnabledCell.set(event.notification.enabled);
          scheduleNotifValueCell.set(event.notification.value);
          scheduleNotifUnitCell.set(event.notification.unit);
        } else {
          scheduleNotifEnabledCell.set(false);
          scheduleNotifValueCell.set(1);
          scheduleNotifUnitCell.set("minute");
        }

        // Save the single event
        if (existingIndex >= 0) {
          const updated = [...allEntries];
          const notes = updated[existingIndex].notes || [];
          const noteIndex = notes.findIndex((n: Note) => n.id === noteId);

          if (noteIndex >= 0) {
            const updatedNotes = [...notes];
            const hourStr = scheduleHourCell.get();
            const minute = scheduleMinuteCell.get();
            const periodVal = schedulePeriodCell.get();

            let combinedTime: string | undefined;
            // Only create time if not '--'
            if (hourStr !== "--" && minute !== "--" && periodVal !== "--") {
              const hour12 = parseInt(hourStr, 10);
              let hour24 = hour12;
              if (periodVal === "PM" && hour12 !== 12) {
                hour24 = hour12 + 12;
              } else if (periodVal === "AM" && hour12 === 12) {
                hour24 = 0;
              }
              combinedTime = `${hour24.toString().padStart(2, "0")}:${minute}`;
            }

            const durationVal = scheduleDurationCell.get();

            updatedNotes[noteIndex] = {
              ...updatedNotes[noteIndex],
              text: scheduleTextCell.get(),
              scheduledTime: combinedTime,
              duration: durationVal !== "none" ? durationVal : undefined,
              notificationEnabled: scheduleNotifEnabledCell.get(),
              notificationValue: scheduleNotifValueCell.get(),
              notificationUnit: scheduleNotifUnitCell.get() as
                | "minute"
                | "hour"
                | "day"
                | "week",
            };
            updated[existingIndex] = { date, notes: updatedNotes };
            entries.set(updated);
          }
        }
      } else {
        // Multiple events - replace the current note with the first event and create new notes for the rest
        const updated = [...allEntries];

        if (existingIndex >= 0) {
          const notes = Array.from(updated[existingIndex].notes || []);
          const noteIndex = notes.findIndex((n: any) => n.id === noteId);

          if (noteIndex >= 0) {
            const newNotes: Note[] = [...notes];

            // Update the first event (replace existing note) with SEMANTIC NOTIFICATION LINKING
            const firstEvent = events[0];
            newNotes[noteIndex] = {
              id: noteId,
              text: firstEvent.text,
              ...(firstEvent.time && { scheduledTime: firstEvent.time }),
              ...(firstEvent.duration && { duration: firstEvent.duration }),
              // Only apply notification if THIS EVENT has one
              ...(firstEvent.notification && {
                notificationEnabled: firstEvent.notification.enabled,
                notificationValue: firstEvent.notification.value,
                notificationUnit: firstEvent.notification.unit,
              }),
            };

            // Add additional events as new notes, each with their own notification if any
            for (let i = 1; i < events.length; i++) {
              const event = events[i];
              newNotes.push({
                id: (Date.now() + i).toString(),
                text: event.text,
                ...(event.time && { scheduledTime: event.time }),
                ...(event.duration && { duration: event.duration }),
                // Only apply notification if THIS EVENT has one
                ...(event.notification && {
                  notificationEnabled: event.notification.enabled,
                  notificationValue: event.notification.value,
                  notificationUnit: event.notification.unit,
                }),
              });
            }

            updated[existingIndex] = { date, notes: newNotes };
            entries.set(updated);
          }
        }
      }

      scheduleModalState.set(null);
    });

    // Handlers for scope confirmation buttons - these set scope and perform the save
    const applyScopeThis = handler<
      never,
      {
        entries: Writable<DayEntry[]>;
        recurringSeries: Writable<RecurringSeries[]>;
        seriesOverrides: Writable<SeriesOverride[]>;
        scheduleModalState: Writable<{ noteId: string; date: string } | null>;
        scheduleConfirmingScopeCell: Writable<boolean>;
        scheduleTextCell: Writable<string>;
        scheduleStartDateCell: Writable<string>;
        scheduleHourCell: Writable<string>;
        scheduleMinuteCell: Writable<string>;
        schedulePeriodCell: Writable<string>;
        scheduleDurationCell: Writable<string>;
        scheduleNotifEnabledCell: Writable<boolean>;
        scheduleNotifValueCell: Writable<number>;
        scheduleNotifUnitCell: Writable<string>;
        scheduleRepeatCell: Writable<string>;
        scheduleRepeatDaysCell: Writable<string[]>;
        scheduleMonthlyPatternCell: Writable<string>;
        scheduleRepeatEndsCell: Writable<string>;
        scheduleRepeatUntilCell: Writable<string>;
        scheduleRepeatCountCell: Writable<number>;
        scheduleEditScopeCell: Writable<string>;
      }
    >((_event, state) => {
      // Set scope and reset confirmation state
      state.scheduleEditScopeCell.set("this");
      state.scheduleConfirmingScopeCell.set(false);
      // Perform the save with the selected scope
      performSaveLogic(state);
    });

    const applyScopeFuture = handler<
      never,
      {
        entries: Writable<DayEntry[]>;
        recurringSeries: Writable<RecurringSeries[]>;
        seriesOverrides: Writable<SeriesOverride[]>;
        scheduleModalState: Writable<{ noteId: string; date: string } | null>;
        scheduleConfirmingScopeCell: Writable<boolean>;
        scheduleTextCell: Writable<string>;
        scheduleStartDateCell: Writable<string>;
        scheduleHourCell: Writable<string>;
        scheduleMinuteCell: Writable<string>;
        schedulePeriodCell: Writable<string>;
        scheduleDurationCell: Writable<string>;
        scheduleNotifEnabledCell: Writable<boolean>;
        scheduleNotifValueCell: Writable<number>;
        scheduleNotifUnitCell: Writable<string>;
        scheduleRepeatCell: Writable<string>;
        scheduleRepeatDaysCell: Writable<string[]>;
        scheduleMonthlyPatternCell: Writable<string>;
        scheduleRepeatEndsCell: Writable<string>;
        scheduleRepeatUntilCell: Writable<string>;
        scheduleRepeatCountCell: Writable<number>;
        scheduleEditScopeCell: Writable<string>;
      }
    >((_event, state) => {
      state.scheduleEditScopeCell.set("future");
      state.scheduleConfirmingScopeCell.set(false);
      performSaveLogic(state);
    });

    const applyScopeAll = handler<
      never,
      {
        entries: Writable<DayEntry[]>;
        recurringSeries: Writable<RecurringSeries[]>;
        seriesOverrides: Writable<SeriesOverride[]>;
        scheduleModalState: Writable<{ noteId: string; date: string } | null>;
        scheduleConfirmingScopeCell: Writable<boolean>;
        scheduleTextCell: Writable<string>;
        scheduleStartDateCell: Writable<string>;
        scheduleHourCell: Writable<string>;
        scheduleMinuteCell: Writable<string>;
        schedulePeriodCell: Writable<string>;
        scheduleDurationCell: Writable<string>;
        scheduleNotifEnabledCell: Writable<boolean>;
        scheduleNotifValueCell: Writable<number>;
        scheduleNotifUnitCell: Writable<string>;
        scheduleRepeatCell: Writable<string>;
        scheduleRepeatDaysCell: Writable<string[]>;
        scheduleMonthlyPatternCell: Writable<string>;
        scheduleRepeatEndsCell: Writable<string>;
        scheduleRepeatUntilCell: Writable<string>;
        scheduleRepeatCountCell: Writable<number>;
        scheduleEditScopeCell: Writable<string>;
      }
    >((_event, state) => {
      state.scheduleEditScopeCell.set("all");
      state.scheduleConfirmingScopeCell.set(false);
      performSaveLogic(state);
    });

    const cancelScopeConfirmation = handler<
      never,
      { scheduleConfirmingScopeCell: Writable<boolean> }
    >((_event, { scheduleConfirmingScopeCell }) => {
      scheduleConfirmingScopeCell.set(false);
    });

    // Handlers for deletion scope confirmation buttons
    const deleteScopeThis = handler<
      never,
      {
        entries: Writable<DayEntry[]>;
        recurringSeries: Writable<RecurringSeries[]>;
        seriesOverrides: Writable<SeriesOverride[]>;
        deletionConfirmingScopeCell: Writable<boolean>;
        deletionPendingCell: Writable<{ noteId: string; date: string } | null>;
        scheduleEditScopeCell: Writable<string>;
      }
    >((_event, state) => {
      const pending = state.deletionPendingCell.get();
      if (!pending) return;

      state.scheduleEditScopeCell.set("this");
      state.deletionConfirmingScopeCell.set(false);
      performDeleteLogic({
        entries: state.entries,
        recurringSeries: state.recurringSeries,
        seriesOverrides: state.seriesOverrides,
        noteId: pending.noteId,
        date: pending.date,
        deleteScope: "this",
      });
      state.deletionPendingCell.set(null);
    });

    const deleteScopeFuture = handler<
      never,
      {
        entries: Writable<DayEntry[]>;
        recurringSeries: Writable<RecurringSeries[]>;
        seriesOverrides: Writable<SeriesOverride[]>;
        deletionConfirmingScopeCell: Writable<boolean>;
        deletionPendingCell: Writable<{ noteId: string; date: string } | null>;
        scheduleEditScopeCell: Writable<string>;
      }
    >((_event, state) => {
      const pending = state.deletionPendingCell.get();
      if (!pending) return;

      state.scheduleEditScopeCell.set("future");
      state.deletionConfirmingScopeCell.set(false);
      performDeleteLogic({
        entries: state.entries,
        recurringSeries: state.recurringSeries,
        seriesOverrides: state.seriesOverrides,
        noteId: pending.noteId,
        date: pending.date,
        deleteScope: "future",
      });
      state.deletionPendingCell.set(null);
    });

    const deleteScopeAll = handler<
      never,
      {
        entries: Writable<DayEntry[]>;
        recurringSeries: Writable<RecurringSeries[]>;
        seriesOverrides: Writable<SeriesOverride[]>;
        deletionConfirmingScopeCell: Writable<boolean>;
        deletionPendingCell: Writable<{ noteId: string; date: string } | null>;
        scheduleEditScopeCell: Writable<string>;
      }
    >((_event, state) => {
      const pending = state.deletionPendingCell.get();
      if (!pending) return;

      state.scheduleEditScopeCell.set("all");
      state.deletionConfirmingScopeCell.set(false);
      performDeleteLogic({
        entries: state.entries,
        recurringSeries: state.recurringSeries,
        seriesOverrides: state.seriesOverrides,
        noteId: pending.noteId,
        date: pending.date,
        deleteScope: "all",
      });
      state.deletionPendingCell.set(null);
    });

    const cancelDeletionConfirmation = handler<
      never,
      {
        deletionConfirmingScopeCell: Writable<boolean>;
        deletionPendingCell: Writable<{ noteId: string; date: string } | null>;
      }
    >((_event, { deletionConfirmingScopeCell, deletionPendingCell }) => {
      deletionConfirmingScopeCell.set(false);
      deletionPendingCell.set(null);
    });

    // Helper function that performs the actual save logic
    const performSaveLogic = (state: {
      entries: Writable<DayEntry[]>;
      recurringSeries: Writable<RecurringSeries[]>;
      seriesOverrides: Writable<SeriesOverride[]>;
      scheduleModalState: Writable<{ noteId: string; date: string } | null>;
      scheduleTextCell: Writable<string>;
      scheduleStartDateCell: Writable<string>;
      scheduleHourCell: Writable<string>;
      scheduleMinuteCell: Writable<string>;
      schedulePeriodCell: Writable<string>;
      scheduleDurationCell: Writable<string>;
      scheduleNotifEnabledCell: Writable<boolean>;
      scheduleNotifValueCell: Writable<number>;
      scheduleNotifUnitCell: Writable<string>;
      scheduleRepeatCell: Writable<string>;
      scheduleRepeatDaysCell: Writable<string[]>;
      scheduleMonthlyPatternCell: Writable<string>;
      scheduleRepeatEndsCell: Writable<string>;
      scheduleRepeatUntilCell: Writable<string>;
      scheduleRepeatCountCell: Writable<number>;
      scheduleEditScopeCell: Writable<string>;
    }) => {
      const {
        entries,
        recurringSeries,
        seriesOverrides,
        scheduleModalState,
        scheduleTextCell,
        scheduleStartDateCell,
        scheduleHourCell,
        scheduleMinuteCell,
        schedulePeriodCell,
        scheduleDurationCell,
        scheduleNotifEnabledCell,
        scheduleNotifValueCell,
        scheduleNotifUnitCell,
        scheduleRepeatCell,
        scheduleRepeatDaysCell,
        scheduleMonthlyPatternCell,
        scheduleRepeatEndsCell,
        scheduleRepeatUntilCell,
        scheduleRepeatCountCell,
        scheduleEditScopeCell,
      } = state;

      const modalState = scheduleModalState.get();
      if (!modalState) return;

      const { noteId, date } = modalState;
      const repeatType = scheduleRepeatCell.get();

      // Check if we're editing an existing recurring series
      let existingSeriesId: string | undefined;
      if (noteId.includes(":")) {
        [existingSeriesId] = noteId.split(":");
      }

      console.log("[performSaveLogic] Starting save:", {
        noteId,
        date,
        repeatType,
        existingSeriesId,
        allCells: {
          repeat: scheduleRepeatCell.get(),
          days: scheduleRepeatDaysCell.get(),
          ends: scheduleRepeatEndsCell.get(),
          until: scheduleRepeatUntilCell.get(),
        },
      });

      // Convert 12-hour time to 24-hour format
      const hour = scheduleHourCell.get();
      const minute = scheduleMinuteCell.get();
      const period = schedulePeriodCell.get();

      let combinedTime: string | undefined;

      // Only create time if not '--'
      if (hour !== "--" && minute !== "--" && period !== "--") {
        let hour24 = parseInt(hour, 10);
        if (period === "PM" && hour24 !== 12) {
          hour24 = hour24 + 12;
        } else if (period === "AM" && hour24 === 12) {
          hour24 = 0;
        }
        combinedTime = `${hour24.toString().padStart(2, "0")}:${minute}`;
      }

      const duration = scheduleDurationCell.get();

      // Check if this should be a recurring series
      if (repeatType !== "none") {
        const allSeries = recurringSeries.get();

        // Check if we're editing an existing series and what scope to apply
        const editScope = scheduleEditScopeCell.get();

        // If editing existing series with scope='this', create an override instead
        if (existingSeriesId && editScope === "this") {
          const [, occurrenceDate] = noteId.split(":");
          const newStartDate = scheduleStartDateCell.get();
          const allOverrides = seriesOverrides.get();

          // Check if the start date has changed
          if (newStartDate !== occurrenceDate) {
            // Start date changed - delete the old occurrence and create a new one-off event

            // 1. Create a deleted override for the old occurrence
            const deletedOverride: SeriesOverride = {
              seriesId: existingSeriesId,
              recurrenceDate: occurrenceDate,
              deleted: true,
            };

            const existingOverrideIndex = allOverrides.findIndex(
              (o: SeriesOverride) =>
                o.seriesId === existingSeriesId &&
                o.recurrenceDate === occurrenceDate,
            );

            if (existingOverrideIndex >= 0) {
              const updated = [...allOverrides];
              updated[existingOverrideIndex] = deletedOverride;
              seriesOverrides.set(updated);
            } else {
              seriesOverrides.set([...allOverrides, deletedOverride]);
            }

            // 2. Create a new one-off event on the new date
            const allEntries = entries.get();
            const newNote: Note = {
              id: `note_${Date.now()}`,
              text: scheduleTextCell.get(),
              scheduledTime: combinedTime,
              duration: duration !== "none" ? duration : undefined,
              notificationEnabled: scheduleNotifEnabledCell.get(),
              notificationValue: scheduleNotifValueCell.get(),
              notificationUnit: scheduleNotifUnitCell.get() as
                | "minute"
                | "hour"
                | "day"
                | "week",
            };

            const newDateIndex = allEntries.findIndex((e: DayEntry) =>
              e.date === newStartDate
            );
            if (newDateIndex >= 0) {
              const updated = [...allEntries];
              updated[newDateIndex] = {
                date: newStartDate,
                notes: [...updated[newDateIndex].notes, newNote],
              };
              entries.set(updated);
            } else {
              entries.set([...allEntries, {
                date: newStartDate,
                notes: [newNote],
              }]);
            }

            scheduleModalState.set(null);
            return;
          }

          // Start date unchanged - just create/update the override
          const existingOverrideIndex = allOverrides.findIndex(
            (o: SeriesOverride) =>
              o.seriesId === existingSeriesId &&
              o.recurrenceDate === occurrenceDate,
          );

          const override: SeriesOverride = {
            seriesId: existingSeriesId,
            recurrenceDate: occurrenceDate,
            text: scheduleTextCell.get(),
            scheduledTime: combinedTime,
            duration: duration !== "none" ? duration : undefined,
            notificationEnabled: scheduleNotifEnabledCell.get(),
            notificationValue: scheduleNotifValueCell.get(),
            notificationUnit: scheduleNotifUnitCell.get() as
              | "minute"
              | "hour"
              | "day"
              | "week",
          };

          if (existingOverrideIndex >= 0) {
            const updated = [...allOverrides];
            updated[existingOverrideIndex] = override;
            seriesOverrides.set(updated);
          } else {
            seriesOverrides.set([...allOverrides, override]);
          }

          scheduleModalState.set(null);
          return;
        }

        // If editing existing series with scope='future', split the series
        if (existingSeriesId && editScope === "future") {
          const [, occurrenceDate] = noteId.split(":");
          const allSeries = recurringSeries.get();

          // Find the existing series
          const existingSeriesIndex = allSeries.findIndex((
            s: RecurringSeries,
          ) => s.seriesId === existingSeriesId);
          if (existingSeriesIndex >= 0) {
            const existingSeries = allSeries[existingSeriesIndex];

            // Calculate the day before this occurrence for the until date
            const currentOccurrence = new Date(occurrenceDate + "T00:00:00");
            const dayBefore = new Date(currentOccurrence);
            dayBefore.setDate(dayBefore.getDate() - 1);
            const untilDate = dayBefore.toISOString().split("T")[0];

            // Update existing series to end before this occurrence
            const updatedExistingSeries = {
              ...existingSeries,
              until: untilDate,
            };

            // Create new series starting from this occurrence with new settings
            const newSeriesId = `series_${Date.now()}`;
            let rrule = "";
            if (repeatType === "daily") {
              rrule = "FREQ=DAILY";
            } else if (repeatType === "weekly") {
              const days = scheduleRepeatDaysCell.get();
              if (days.length > 0) {
                rrule = `FREQ=WEEKLY;BYDAY=${days.join(",")}`;
              } else {
                rrule = "FREQ=WEEKLY";
              }
            } else if (repeatType === "monthly") {
              const monthlyPattern = scheduleMonthlyPatternCell.get();
              const startDate = scheduleStartDateCell.get();
              if (monthlyPattern === "dayOfMonth" && startDate) {
                // Monthly on specific day of month (e.g., 15th)
                const date = new Date(startDate + "T00:00:00");
                const dayOfMonth = date.getDate();
                rrule = `FREQ=MONTHLY;BYMONTHDAY=${dayOfMonth}`;
              } else if (monthlyPattern === "weekdayOfMonth" && startDate) {
                // Monthly on specific weekday position (e.g., first Friday)
                const date = new Date(startDate + "T00:00:00");
                const dayOfWeek = date.getDay();
                const dayMap = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
                const dayCode = dayMap[dayOfWeek];
                const dayOfMonth = date.getDate();
                const weekOfMonth = Math.floor((dayOfMonth - 1) / 7) + 1; // 1-5
                rrule = `FREQ=MONTHLY;BYDAY=${weekOfMonth}${dayCode}`;
              } else {
                rrule = "FREQ=MONTHLY";
              }
            }

            const newSeries: RecurringSeries = {
              seriesId: newSeriesId,
              parentSeriesId: existingSeriesId, // Track lineage for comprehensive deletion
              text: scheduleTextCell.get(),
              rrule,
              dtstart: occurrenceDate,
              scheduledTime: combinedTime,
              duration: duration !== "none" ? duration : undefined,
              notificationEnabled: scheduleNotifEnabledCell.get(),
              notificationValue: scheduleNotifValueCell.get(),
              notificationUnit: scheduleNotifUnitCell.get() as
                | "minute"
                | "hour"
                | "day"
                | "week",
            };

            // Add ends condition from existing series if present
            const endsType = scheduleRepeatEndsCell.get();
            if (endsType === "on") {
              const until = scheduleRepeatUntilCell.get();
              if (until) newSeries.until = until;
            }

            // Update series list
            const updated = [...allSeries];
            updated[existingSeriesIndex] = updatedExistingSeries;
            updated.push(newSeries);
            recurringSeries.set(updated);

            // Clean up: Mark occurrences on removed days as deleted
            // Extract old BYDAY from existing series
            const oldRruleParts: Record<string, string> = {};
            if (existingSeries.rrule) {
              existingSeries.rrule.split(";").forEach((part) => {
                const [key, value] = part.split("=");
                if (key && value) oldRruleParts[key] = value;
              });
            }
            const oldDays = oldRruleParts["BYDAY"]?.split(",") || [];
            const newDays = scheduleRepeatDaysCell.get();

            // Find days that were removed (in old but not in new)
            const removedDays = oldDays.filter((day) => !newDays.includes(day));

            if (removedDays.length > 0 && repeatType === "weekly") {
              // Map day codes to day-of-week numbers (0=Sunday, 6=Saturday)
              const dayMap: Record<string, number> = {
                "SU": 0,
                "MO": 1,
                "TU": 2,
                "WE": 3,
                "TH": 4,
                "FR": 5,
                "SA": 6,
              };

              const allOverrides = seriesOverrides.get();
              const updatedOverrides: SeriesOverride[] = [];
              const overridesToUpdate = new Set<string>(); // Track which overrides need updating

              // Generate dates for next 365 days to find occurrences on removed days
              const splitDate = new Date(occurrenceDate + "T00:00:00");
              const endDate = new Date(splitDate);
              endDate.setDate(endDate.getDate() + 365);

              // First pass: identify all dates on removed days that need deletion
              const datesToDelete: string[] = [];
              for (
                const d = new Date(splitDate);
                d <= endDate;
                d.setDate(d.getDate() + 1)
              ) {
                const dayOfWeek = d.getDay();
                const dateStr = d.toISOString().split("T")[0];

                for (const removedDay of removedDays) {
                  if (dayMap[removedDay] === dayOfWeek) {
                    datesToDelete.push(dateStr);
                    break;
                  }
                }
              }

              // Second pass: update existing overrides or create new ones
              const processedDates = new Set<string>();

              // Process existing overrides - mark those on removed days as deleted
              const modifiedOverrides = allOverrides.map(
                (o: SeriesOverride) => {
                  if (
                    o.seriesId === existingSeriesId &&
                    datesToDelete.includes(o.recurrenceDate)
                  ) {
                    processedDates.add(o.recurrenceDate);
                    if (!o.deleted) {
                      overridesToUpdate.add(o.recurrenceDate);
                      return { ...o, deleted: true };
                    }
                  }
                  return o;
                },
              );

              // Create new deleted overrides for dates that don't have existing overrides
              for (const dateStr of datesToDelete) {
                if (!processedDates.has(dateStr)) {
                  updatedOverrides.push({
                    seriesId: existingSeriesId,
                    recurrenceDate: dateStr,
                    deleted: true,
                  });
                }
              }

              if (updatedOverrides.length > 0 || overridesToUpdate.size > 0) {
                seriesOverrides.set([
                  ...modifiedOverrides,
                  ...updatedOverrides,
                ]);
              }
            }

            scheduleModalState.set(null);
            return;
          }
        }

        // Otherwise, update the entire series (scope='all' or creating new series)
        const seriesId = existingSeriesId || `series_${Date.now()}`;

        let rrule = "";
        if (repeatType === "daily") {
          rrule = "FREQ=DAILY";
        } else if (repeatType === "weekly") {
          const days = scheduleRepeatDaysCell.get();
          if (days.length > 0) {
            rrule = `FREQ=WEEKLY;BYDAY=${days.join(",")}`;
          } else {
            rrule = "FREQ=WEEKLY";
          }
        } else if (repeatType === "monthly") {
          const monthlyPattern = scheduleMonthlyPatternCell.get();
          const startDate = scheduleStartDateCell.get();
          if (monthlyPattern === "dayOfMonth" && startDate) {
            // Monthly on specific day of month (e.g., 15th)
            const date = new Date(startDate + "T00:00:00");
            const dayOfMonth = date.getDate();
            rrule = `FREQ=MONTHLY;BYMONTHDAY=${dayOfMonth}`;
          } else if (monthlyPattern === "weekdayOfMonth" && startDate) {
            // Monthly on specific weekday position (e.g., first Friday)
            const date = new Date(startDate + "T00:00:00");
            const dayOfWeek = date.getDay();
            const dayMap = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
            const dayCode = dayMap[dayOfWeek];
            const dayOfMonth = date.getDate();
            const weekOfMonth = Math.floor((dayOfMonth - 1) / 7) + 1; // 1-5
            rrule = `FREQ=MONTHLY;BYDAY=${weekOfMonth}${dayCode}`;
          } else {
            rrule = "FREQ=MONTHLY";
          }
        }

        const updatedSeries: RecurringSeries = {
          seriesId,
          text: scheduleTextCell.get(),
          rrule,
          dtstart: scheduleStartDateCell.get(),
          scheduledTime: combinedTime,
          duration: duration !== "none" ? duration : undefined,
          notificationEnabled: scheduleNotifEnabledCell.get(),
          notificationValue: scheduleNotifValueCell.get(),
          notificationUnit: scheduleNotifUnitCell.get() as
            | "minute"
            | "hour"
            | "day"
            | "week",
        };

        // Add ends condition
        const endsType = scheduleRepeatEndsCell.get();
        if (endsType === "on") {
          const until = scheduleRepeatUntilCell.get();
          if (until) updatedSeries.until = until;
        } else if (endsType === "after") {
          updatedSeries.count = scheduleRepeatCountCell.get();
        }

        // Update existing series or add new one
        if (existingSeriesId) {
          // Update existing series
          const updatedList = allSeries.map((s: RecurringSeries) =>
            s.seriesId === existingSeriesId ? updatedSeries : s
          );
          recurringSeries.set(updatedList);
        } else {
          // Add new series
          recurringSeries.set([...allSeries, updatedSeries]);
        }

        // Delete the original note if we're converting a one-off to recurring
        // (but not if we're just editing an existing recurring series)
        if (!existingSeriesId) {
          const allEntries = entries.get();
          const existingIndex = allEntries.findIndex((e: DayEntry) =>
            e.date === date
          );
          if (existingIndex >= 0) {
            const updated = [...allEntries];
            const notes = updated[existingIndex].notes || [];
            const filteredNotes = notes.filter((n: Note) => n.id !== noteId);

            if (filteredNotes.length > 0) {
              updated[existingIndex] = { date, notes: filteredNotes };
            } else {
              updated.splice(existingIndex, 1);
            }
            entries.set(updated);
          }
        }

        scheduleModalState.set(null);
        return;
      }

      // Otherwise, handle as one-off event (existing logic)
      const allEntries = entries.get();
      const existingIndex = allEntries.findIndex((e: DayEntry) =>
        e.date === date
      );

      if (existingIndex >= 0) {
        const updated = [...allEntries];
        const notes = updated[existingIndex].notes || [];
        const noteIndex = notes.findIndex((n: Note) => n.id === noteId);

        if (noteIndex >= 0) {
          const updatedNotes = [...notes];
          updatedNotes[noteIndex] = {
            ...updatedNotes[noteIndex],
            text: scheduleTextCell.get(),
            scheduledTime: combinedTime,
            duration: duration !== "none" ? duration : undefined,
            notificationEnabled: scheduleNotifEnabledCell.get(),
            notificationValue: scheduleNotifValueCell.get(),
            notificationUnit: scheduleNotifUnitCell.get() as
              | "minute"
              | "hour"
              | "day"
              | "week",
          };
          updated[existingIndex] = { date, notes: updatedNotes };
          entries.set(updated);
          scheduleModalState.set(null);
        }
      }
    };

    // Handler to save schedule from modal
    const saveSchedule = handler<
      never,
      {
        entries: Writable<DayEntry[]>;
        recurringSeries: Writable<RecurringSeries[]>;
        seriesOverrides: Writable<SeriesOverride[]>;
        scheduleModalState: Writable<{ noteId: string; date: string } | null>;
        scheduleConfirmingScopeCell: Writable<boolean>;
        scheduleTextCell: Writable<string>;
        scheduleStartDateCell: Writable<string>;
        scheduleHourCell: Writable<string>;
        scheduleMinuteCell: Writable<string>;
        schedulePeriodCell: Writable<string>;
        scheduleDurationCell: Writable<string>;
        scheduleNotifEnabledCell: Writable<boolean>;
        scheduleNotifValueCell: Writable<number>;
        scheduleNotifUnitCell: Writable<string>;
        scheduleRepeatCell: Writable<string>;
        scheduleRepeatDaysCell: Writable<string[]>;
        scheduleMonthlyPatternCell: Writable<string>;
        scheduleRepeatEndsCell: Writable<string>;
        scheduleRepeatUntilCell: Writable<string>;
        scheduleRepeatCountCell: Writable<number>;
        scheduleEditScopeCell: Writable<string>;
      }
    >((_event, state) => {
      const { scheduleModalState, scheduleConfirmingScopeCell } = state;
      const modalState = scheduleModalState.get();
      if (!modalState) return;

      const { noteId } = modalState;

      // Check if we're editing an existing recurring series
      if (noteId.includes(":")) {
        // This is a recurring occurrence - need confirmation first
        const isConfirming = scheduleConfirmingScopeCell.get();
        if (!isConfirming) {
          // Show confirmation dialog and return early
          scheduleConfirmingScopeCell.set(true);
          return;
        }

        // User has confirmed - reset confirmation state and proceed with save
        scheduleConfirmingScopeCell.set(false);
      }

      // Perform the actual save logic
      performSaveLogic(state);
    });

    // Handler to update note schedule
    const _updateSchedule = handler<
      {
        time: string;
        notificationEnabled: boolean;
        notificationValue: number;
        notificationUnit: string;
      },
      {
        entries: Writable<DayEntry[]>;
        noteId: string;
        date: string;
        scheduleModalState: Writable<{ noteId: string; date: string } | null>;
      }
    >((
      { time, notificationEnabled, notificationValue, notificationUnit },
      { entries, noteId, date, scheduleModalState },
    ) => {
      const allEntries = entries.get();
      const existingIndex = allEntries.findIndex((e: DayEntry) =>
        e.date === date
      );

      if (existingIndex >= 0) {
        const updated = [...allEntries];
        const notes = updated[existingIndex].notes || [];
        const noteIndex = notes.findIndex((n: Note) => n.id === noteId);

        if (noteIndex >= 0) {
          const updatedNotes = [...notes];
          updatedNotes[noteIndex] = {
            ...updatedNotes[noteIndex],
            scheduledTime: time,
            notificationEnabled,
            notificationValue,
            notificationUnit: notificationUnit as
              | "minute"
              | "hour"
              | "day"
              | "week",
          };
          updated[existingIndex] = { date, notes: updatedNotes };
          entries.set(updated);
          scheduleModalState.set(null);
        }
      }
    });

    return {
      [NAME]: str`${name}`,
      [UI]: (
        <ct-screen>
          <style>
            {`
              ct-screen {
                display: flex;
                flex-direction: column;
                height: 100%;
                overflow: hidden;
              }

              * {
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
              }

              .calendar-grid {
                display: grid;
                grid-template-columns: repeat(7, 1fr);
                gap: 2px;
                max-width: 420px;
                background: #f5f5f7;
                padding: 2px;
                border-radius: 12px;
              }

              .calendar-day-header {
                text-align: center;
                font-weight: 500;
                padding: 12px 8px;
                font-size: 0.6875rem;
                color: #86868b;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                background: transparent;
              }

              .calendar-day {
                aspect-ratio: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                background: white;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.15s ease;
                padding: 4px;
                min-height: 44px;
                font-size: 0.9375rem;
                font-weight: 400;
                position: relative;
                color: #1d1d1f;
              }

              .calendar-day:hover:not(.empty) {
                background: #f5f5f7;
                transform: scale(1.02);
              }

              .calendar-day.selected:hover {
                background: #0051d5;
                color: white;
              }

              .calendar-day.empty {
                cursor: default;
                background: transparent;
              }

              .calendar-day.other-month {
                color: #d8d8dc;
                background: #f5f5f7;
              }

              .calendar-day.other-month:hover {
                background: #e8e8ed;
                color: #86868b;
              }

              .calendar-day.past:not(.other-month) {
                color: #86868b;
                background: #fafafa;
              }

              .calendar-day.past:not(.other-month):hover {
                background: #f0f0f0;
              }

              .calendar-day.today {
                border: 2px solid #007aff;
                font-weight: 500;
              }

              .calendar-day.selected {
                background: #007aff;
                color: white;
                font-weight: 500;
                box-shadow: 0 2px 8px rgba(0, 122, 255, 0.3);
                border: 2px solid #007aff;
              }

              .calendar-day.selected.today {
                border: 2px solid #0051d5;
              }

              .calendar-day.has-entry::after {
                content: '';
                position: absolute;
                bottom: 6px;
                width: 4px;
                height: 4px;
                background: #34c759;
                border-radius: 50%;
              }

              .calendar-day.selected.has-entry::after {
                background: white;
              }

              .month-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                margin-bottom: 16px;
              }

              .month-year-selectors {
                display: flex;
                align-items: center;
                gap: 8px;
              }

              .month-year-selectors ct-select {
                --ct-theme-font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
                --ct-theme-border-radius: 0;
                --ct-theme-color-border: transparent;
                --ct-theme-color-background: transparent;
                --ct-theme-color-text: #1d1d1f;
                font-size: 1.375rem;
                font-weight: 600;
              }

              .month-header h3 {
                font-size: 1.375rem;
                font-weight: 600;
                letter-spacing: -0.5px;
                color: #1d1d1f;
              }

              .date-nav {
                display: flex;
                align-items: center;
                gap: 16px;
                margin-bottom: 24px;
              }

              .date-nav h2 {
                font-size: 1.75rem;
                font-weight: 600;
                letter-spacing: -0.5px;
                color: #1d1d1f;
              }

              .daily-note-header {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 8px;
              }

              .daily-note-label {
                font-size: 0.875rem;
                font-weight: 600;
                color: #1d1d1f;
                letter-spacing: -0.2px;
              }

              .add-note-button {
                width: 24px;
                height: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: transparent;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                color: #86868b;
                transition: all 0.15s ease;
                font-size: 16px;
                font-weight: 400;
              }

              .add-note-button:hover {
                background: #f5f5f7;
                color: #007aff;
              }

              .time-grid-container {
                margin: 8px 0 16px 0;
              }

              .time-grid {
                display: flex;
                flex-direction: column;
                gap: 8px;
                max-height: 400px;
                overflow-y: auto;
                overflow-x: hidden;
                scrollbar-width: thin;
                scrollbar-color: #d1d1d6 transparent;
                align-items: flex-start;
              }

              .time-grid::-webkit-scrollbar {
                width: 6px;
              }

              .time-grid::-webkit-scrollbar-track {
                background: transparent;
              }

              .time-grid::-webkit-scrollbar-thumb {
                background: #d1d1d6;
                border-radius: 3px;
              }

              .time-grid::-webkit-scrollbar-thumb:hover {
                background: #c1c1c6;
              }

              .timeline-grid {
                display: grid;
                grid-template-columns: 1fr;
                gap: 8px;
                grid-auto-flow: dense;
              }

              .time-slot {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 0.75rem;
                font-weight: 500;
                color: #86868b;
                background: #fafafa;
                padding: 8px 12px;
                border: 1px solid #e8e8ed;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.15s ease;
                font-family: -apple-system, BlinkMacSystemFont, "SF Mono", "Monaco", "Courier New", monospace;
                letter-spacing: 0.2px;
                min-height: 32px;
                width: 130px;
                box-sizing: border-box;
              }

              .time-slot:hover {
                background: #e3f2fd;
                color: #007aff;
                border-color: #007aff;
                transform: translateY(-1px);
                box-shadow: 0 2px 4px rgba(0, 122, 255, 0.1);
              }

              .time-slot:active {
                transform: translateY(0);
              }

              .note-item {
                /* Spacing handled by ct-vstack gap */
              }

              .note-time {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 0.75rem;
                font-weight: 600;
                color: #007aff;
                background: #e3f2fd;
                padding: 6px 8px;
                border-radius: 6px;
                width: 130px;
                min-height: 32px;
                align-self: stretch;
                flex-shrink: 0;
                font-family: -apple-system, BlinkMacSystemFont, "SF Mono", "Monaco", "Courier New", monospace;
                letter-spacing: 0.3px;
                cursor: pointer;
                transition: all 0.15s ease;
                box-sizing: border-box;
              }

              .note-time:hover {
                background: #d0e7f9;
                color: #0056b3;
              }

              .clock-button {
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: transparent;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                color: #86868b;
                transition: all 0.15s ease;
                font-size: 16px;
                flex-shrink: 0;
                align-self: center;
              }

              .clock-button:hover {
                background: #f5f5f7;
                color: #007aff;
              }

              .clock-button-alert {
                background: #fff3cd;
                color: #ff9500;
                border: 1px solid #ffc107;
                animation: pulse-alert 2s ease-in-out infinite;
              }

              .clock-button-alert:hover {
                background: #ffe69c;
                color: #ff8800;
                border-color: #ffb300;
              }

              .magic-wand-button {
                background: #f5f5f7;
                color: #86868b;
                border: none;
                border-radius: 6px;
                width: 32px;
                height: 32px;
                cursor: pointer;
                font-size: 14px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.15s ease;
                flex-shrink: 0;
              }

              .magic-wand-button:hover {
                background: #e8e8ed;
                color: #007aff;
              }

              .magic-wand-button:active {
                background: #d1d1d6;
                transform: scale(0.95);
              }

              .delete-modal-button {
                background: #f5f5f7;
                color: #86868b;
                border: none;
                border-radius: 6px;
                width: 32px;
                height: 32px;
                cursor: pointer;
                font-size: 16px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.15s ease;
                flex-shrink: 0;
              }

              .delete-modal-button:hover {
                background: #ffebee;
                color: #ff3b30;
              }

              .delete-modal-button:active {
                background: #ffcdd2;
                transform: scale(0.95);
              }

              @keyframes pulse-alert {
                0%, 100% {
                  box-shadow: 0 0 0 0 rgba(255, 193, 7, 0.4);
                }
                50% {
                  box-shadow: 0 0 0 4px rgba(255, 193, 7, 0);
                }
              }

              .delete-note-button {
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: transparent;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                color: #86868b;
                transition: all 0.15s ease;
                font-size: 20px;
                flex-shrink: 0;
                align-self: center;
              }

              .delete-note-button:hover {
                background: #ffebee;
                color: #ff3b30;
              }

              .done-edit-button {
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: #007aff;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                color: white;
                font-size: 16px;
                font-weight: bold;
                margin-left: 4px;
                flex-shrink: 0;
              }

              .done-edit-button:hover {
                background: #0051d5;
              }

              .edit-container {
                flex: 1;
                gap: 0;
              }

              .entries-header {
                font-size: 1rem;
                font-weight: 600;
                color: #1d1d1f;
                letter-spacing: -0.3px;
              }

              .column-section ct-card {
                transition: all 0.15s ease;
                width: 100%;
                max-width: 100%;
                box-sizing: border-box;
              }

              .column-section ct-card:hover {
                background: #f5f5f7;
                transform: translateX(2px);
              }

              .column-section ct-card p {
                word-wrap: break-word;
                overflow-wrap: break-word;
                max-width: 100%;
              }

              .column-section {
                flex-shrink: 0;
                width: 100%;
                max-width: 100%;
              }

              .column-section:last-child {
                flex-shrink: 1;
                min-height: 0;
              }

              .column-section ct-vstack {
                width: 100%;
                max-width: 100%;
                overflow: hidden;
              }

              .note-textarea {
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
                font-size: 0.9375rem;
                line-height: 1.6;
                color: #1d1d1f;
                width: 100%;
                max-width: 100%;
                min-height: 36px;
                padding: 8px 12px;
                border: 1px solid #d2d2d7;
                border-radius: 8px;
                box-sizing: border-box;
                resize: vertical;
                background: white;
                transition: border-color 0.15s ease;
                flex: 1;
              }

              .note-textarea:focus {
                outline: none;
                border-color: #007aff;
                box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.1);
              }

              .note-textarea::placeholder {
                color: #86868b;
              }

              .note-text-static {
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
                font-size: 0.9375rem;
                line-height: 1.6;
                color: #1d1d1f;
                width: 100%;
                max-width: 100%;
                min-height: 36px;
                padding: 8px 12px;
                border: 1px solid transparent;
                border-radius: 8px;
                box-sizing: border-box;
                background: white;
                cursor: pointer;
                transition: border-color 0.15s ease, background-color 0.15s ease;
                flex: 1;
                display: flex;
                align-items: center;
              }

              .note-text-static:hover {
                border-color: #d2d2d7;
                background-color: #f5f5f7;
              }

              .main-layout {
                display: flex;
                gap: 32px;
                flex: 1;
                min-height: 0;
                overflow: hidden;
              }

              .left-column {
                flex: 1;
                min-width: 0;
                min-height: 0;
                display: flex;
                flex-direction: column;
                overflow-y: auto;
                padding: 24px;
                gap: 24px;
              }

              .right-column {
                flex-shrink: 0;
                width: 420px;
                min-height: 0;
                display: flex;
                flex-direction: column;
                overflow-y: auto;
                padding: 24px;
                gap: 16px;
              }

              .date-picker-container {
                display: none;
              }

              .date-picker-input {
                width: auto;
                max-width: 200px;
                padding: 8px 12px;
                border: 1px solid #d2d2d7;
                border-radius: 8px;
                font-size: 1rem;
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
                box-sizing: border-box;
                background: white;
                cursor: pointer;
              }

              .date-picker-input::-webkit-calendar-picker-indicator {
                cursor: pointer;
                padding: 4px;
              }

              .settings-button {
                position: absolute;
                top: 16px;
                right: 16px;
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: transparent;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                color: #86868b;
                transition: all 0.15s ease;
                font-size: 18px;
              }

              .settings-button:hover {
                background: #f5f5f7;
                color: #1d1d1f;
              }

              .settings-modal {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.4);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
              }

              .settings-content {
                background: white;
                border-radius: 16px;
                padding: 28px;
                min-width: 360px;
                max-width: 440px;
                max-height: 90vh;
                overflow-y: auto;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15), 0 0 1px rgba(0, 0, 0, 0.1);
              }

              .settings-header {
                font-size: 1.25rem;
                font-weight: 600;
                margin: 0 0 20px 0;
                color: #1d1d1f;
                letter-spacing: -0.02em;
              }

              .day-selector-grid {
                display: grid;
                grid-template-columns: repeat(7, 1fr);
                gap: 8px;
              }

              .day-button {
                aspect-ratio: 1;
                min-height: 44px;
                border-radius: 50%;
                border: none;
                background: #f5f5f7;
                color: #1d1d1f;
                font-size: 0.875rem;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
                -webkit-tap-highlight-color: transparent;
              }

              .day-button:hover {
                background: #e8e8ed;
                transform: scale(1.05);
              }

              .day-button.selected {
                background: #007aff;
                color: white;
              }

              .day-button.selected:hover {
                background: #0051d5;
              }

              .modal-label {
                font-size: 0.8125rem;
                font-weight: 600;
                color: #1d1d1f;
                margin-bottom: 6px;
                letter-spacing: -0.01em;
              }

              .modal-section {
                margin-bottom: 20px;
              }

              .modal-section:last-child {
                margin-bottom: 0;
              }

              @media (max-width: 900px) {
                .main-layout {
                  flex-direction: column;
                }

                .right-column {
                  display: none;
                }

                .date-picker-container {
                  display: block;
                  margin-bottom: 16px;
                }

                .left-column {
                  width: 100%;
                  padding: 16px;
                }

                .note-textarea {
                  width: 100% !important;
                  max-width: 100% !important;
                }

                .time-slot {
                  width: auto;
                  padding: 8px 10px;
                  font-size: 0.7rem;
                }

                .note-time {
                  width: auto;
                  padding: 6px 10px;
                  font-size: 0.7rem;
                }
              }
            `}
          </style>

          <button
            type="button"
            className="settings-button"
            onClick={toggleSettings({ showSettings })}
          >
            ⚙
          </button>

          {ifElse(
            showSettings,
            <div className="settings-modal">
              <div className="settings-content">
                <h3 className="settings-header">Settings</h3>
                <ct-vstack gap="3">
                  <ct-vstack gap="1">
                    <label style="font-size: 0.875rem; font-weight: 500; color: #1d1d1f;">
                      Calendar Name
                    </label>
                    <ct-message-input
                      placeholder={name}
                      button-text="Save"
                      onct-send={updateName({ name, showSettings })}
                    />
                  </ct-vstack>
                  <ct-vstack gap="2">
                    <label style="font-size: 0.875rem; font-weight: 500; color: #1d1d1f;">
                      Time Grid Settings
                    </label>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                      <div>
                        <label style="font-size: 0.75rem; color: #86868b; display: block; margin-bottom: 4px;">
                          Start Time
                        </label>
                        <ct-select
                          $value={startTime}
                          items={timeSelectItems}
                          style="width: 100%;"
                        />
                      </div>
                      <div>
                        <label style="font-size: 0.75rem; color: #86868b; display: block; margin-bottom: 4px;">
                          End Time
                        </label>
                        <ct-select
                          $value={endTime}
                          items={timeSelectItems}
                          style="width: 100%;"
                        />
                      </div>
                    </div>
                    <div>
                      <label style="font-size: 0.75rem; color: #86868b; display: block; margin-bottom: 4px;">
                        Time Interval
                      </label>
                      <ct-select
                        $value={timeInterval}
                        items={intervalSelectItems}
                        style="width: 100%;"
                      />
                    </div>
                  </ct-vstack>
                  <ct-vstack gap="2">
                    <label style="font-size: 0.875rem; font-weight: 500; color: #1d1d1f;">
                      Display Options
                    </label>
                    <ct-hstack gap="2" style="align-items: center;">
                      <ct-checkbox $checked={showMonthView} />
                      <span style="font-size: 0.875rem; color: #1d1d1f;">
                        Show month calendar
                      </span>
                    </ct-hstack>
                  </ct-vstack>
                  <ct-vstack gap="2">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <label style="font-size: 0.875rem; font-weight: 500; color: #1d1d1f;">
                        Time Labels
                      </label>
                      <button
                        type="button"
                        onClick={addTimeLabel({ customTimeLabels })}
                        style="background: none; border: none; font-size: 20px; cursor: pointer; color: #007aff; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;"
                        title="Add time label"
                      >
                        +
                      </button>
                    </div>
                    <ct-vstack gap="2">
                      {customTimeLabels.map((
                        label: TimeLabel,
                        index: number,
                      ) => (
                        <div
                          key={index}
                          style="display: flex; gap: 8px; align-items: center; padding: 8px; background: #f5f5f7; border-radius: 8px;"
                        >
                          <input
                            type="text"
                            value={label.label}
                            onChange={updateTimeLabel({
                              customTimeLabels,
                              index,
                              field: "label",
                            })}
                            placeholder="Label (e.g., Morning)"
                            style="flex: 1; padding: 6px 8px; font-size: 14px; border: 1px solid #d1d1d6; border-radius: 6px; background: white;"
                          />
                          <input
                            type="time"
                            value={label.time}
                            onChange={updateTimeLabel({
                              customTimeLabels,
                              index,
                              field: "time",
                            })}
                            style="width: 100px; padding: 6px 8px; font-size: 14px; border: 1px solid #d1d1d6; border-radius: 6px; background: white;"
                          />
                          <button
                            type="button"
                            onClick={deleteTimeLabel({
                              customTimeLabels,
                              index,
                            })}
                            style="background: none; border: none; font-size: 18px; cursor: pointer; color: #ff3b30; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;"
                            title="Delete"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </ct-vstack>
                  </ct-vstack>
                  <ct-hstack
                    gap="2"
                    style="justify-content: flex-end; margin-top: 8px;"
                  >
                    <ct-button
                      onClick={closeSettings({ showSettings })}
                      size="sm"
                    >
                      Close
                    </ct-button>
                  </ct-hstack>
                </ct-vstack>
              </div>
            </div>,
            <div></div>,
          )}

          {ifElse(
            derive(scheduleModalState, (state: any) =>
              state !== null && state !== undefined),
            <div className="settings-modal">
              <div className="settings-content">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "12px",
                  }}
                >
                  <h3 className="settings-header" style={{ margin: 0 }}>
                    Schedule Note
                  </h3>
                  <button
                    type="button"
                    onClick={closeScheduleModal({
                      scheduleModalState,
                      isNewEventCell,
                    })}
                    style={{
                      background: "none",
                      border: "none",
                      fontSize: "24px",
                      cursor: "pointer",
                      padding: "0",
                      width: "32px",
                      height: "32px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#86868b",
                      lineHeight: 1,
                    }}
                    title="Close"
                  >
                    ×
                  </button>
                </div>

                {ifElse(
                  scheduleConfirmingScopeCell,
                  // Scope confirmation UI
                  <ct-vstack gap="3" style="padding-bottom: 8px;">
                    <div style="text-align: center; padding: 20px 0 12px 0;">
                      <div style="font-size: 1.125rem; font-weight: 600; margin-bottom: 12px; color: #1d1d1f;">
                        Apply changes to recurring event?
                      </div>
                      <div style="font-size: 0.875rem; color: #86868b;">
                        Choose which occurrences should be updated
                      </div>
                    </div>
                    <ct-vstack
                      gap="2"
                      style="margin-bottom: 4px; padding: 0 2px;"
                    >
                      <div
                        onClick={applyScopeThis({
                          entries,
                          recurringSeries,
                          seriesOverrides,
                          scheduleModalState,
                          scheduleConfirmingScopeCell,
                          scheduleTextCell,
                          scheduleStartDateCell,
                          scheduleHourCell,
                          scheduleMinuteCell,
                          schedulePeriodCell,
                          scheduleDurationCell,
                          scheduleNotifEnabledCell,
                          scheduleNotifValueCell,
                          scheduleNotifUnitCell,
                          scheduleRepeatCell,
                          scheduleRepeatDaysCell,
                          scheduleMonthlyPatternCell,
                          scheduleRepeatEndsCell,
                          scheduleRepeatUntilCell,
                          scheduleRepeatCountCell,
                          scheduleEditScopeCell,
                        })}
                        style="cursor: pointer; width: 100%; padding: 16px; background: white; border: 2px solid #e5e5e7; border-radius: 12px; text-align: left; transition: all 0.2s ease;"
                      >
                        <div style="font-weight: 600; margin-bottom: 4px; color: #1d1d1f;">
                          This event only
                        </div>
                        <div style="font-size: 0.8125rem; color: #86868b;">
                          Only this occurrence will be changed
                        </div>
                      </div>
                      <div
                        onClick={applyScopeFuture({
                          entries,
                          recurringSeries,
                          seriesOverrides,
                          scheduleModalState,
                          scheduleConfirmingScopeCell,
                          scheduleTextCell,
                          scheduleStartDateCell,
                          scheduleHourCell,
                          scheduleMinuteCell,
                          schedulePeriodCell,
                          scheduleDurationCell,
                          scheduleNotifEnabledCell,
                          scheduleNotifValueCell,
                          scheduleNotifUnitCell,
                          scheduleRepeatCell,
                          scheduleRepeatDaysCell,
                          scheduleMonthlyPatternCell,
                          scheduleRepeatEndsCell,
                          scheduleRepeatUntilCell,
                          scheduleRepeatCountCell,
                          scheduleEditScopeCell,
                        })}
                        style="cursor: pointer; width: 100%; padding: 16px; background: white; border: 2px solid #e5e5e7; border-radius: 12px; text-align: left; transition: all 0.2s ease;"
                      >
                        <div style="font-weight: 600; margin-bottom: 4px; color: #1d1d1f;">
                          This and future events
                        </div>
                        <div style="font-size: 0.8125rem; color: #86868b;">
                          This and all following occurrences will be changed
                        </div>
                      </div>
                      {ifElse(
                        derive(weeklyDaysHaveChanged, (changed: any) =>
                          !changed),
                        <div
                          onClick={applyScopeAll({
                            entries,
                            recurringSeries,
                            seriesOverrides,
                            scheduleModalState,
                            scheduleConfirmingScopeCell,
                            scheduleTextCell,
                            scheduleStartDateCell,
                            scheduleHourCell,
                            scheduleMinuteCell,
                            schedulePeriodCell,
                            scheduleDurationCell,
                            scheduleNotifEnabledCell,
                            scheduleNotifValueCell,
                            scheduleNotifUnitCell,
                            scheduleRepeatCell,
                            scheduleRepeatDaysCell,
                            scheduleMonthlyPatternCell,
                            scheduleRepeatEndsCell,
                            scheduleRepeatUntilCell,
                            scheduleRepeatCountCell,
                            scheduleEditScopeCell,
                          })}
                          style="cursor: pointer; width: 100%; padding: 16px 16px 18px 16px; background: white; border: 2px solid #e5e5e7; border-radius: 12px; text-align: left; transition: all 0.2s ease;"
                        >
                          <div style="font-weight: 600; margin-bottom: 4px; color: #1d1d1f;">
                            All events in series
                          </div>
                          <div style="font-size: 0.8125rem; color: #86868b; line-height: 1.4;">
                            All past and future occurrences will be changed
                          </div>
                        </div>,
                        <div></div>,
                      )}
                    </ct-vstack>
                    <ct-button
                      onClick={cancelScopeConfirmation({
                        scheduleConfirmingScopeCell,
                      })}
                      size="sm"
                      variant="ghost"
                      style="margin-top: 8px;"
                    >
                      Cancel
                    </ct-button>
                  </ct-vstack>,
                  // Normal edit UI
                  <ct-vstack gap="4">
                    <div className="modal-section">
                      <div className="modal-label">Note</div>
                      <ct-input
                        type="text"
                        $value={scheduleTextCell}
                        onChange={onNoteChange({
                          scheduleTextCell,
                          scheduleHourCell,
                          scheduleMinuteCell,
                          schedulePeriodCell,
                          scheduleDurationCell,
                          scheduleNotifEnabledCell,
                          scheduleNotifValueCell,
                          scheduleNotifUnitCell,
                          scheduleRepeatCell,
                          scheduleRepeatDaysCell,
                          scheduleMonthlyPatternCell,
                          scheduleModalState,
                          customTimeLabels,
                        })}
                        placeholder="e.g., Meeting at 2pm"
                        style="width: 100%; padding: 8px; font-size: 14px; border: 1px solid #e5e5e7; border-radius: 8px;"
                      />
                    </div>

                    <div className="modal-section">
                      <div className="modal-label">Start Date & Time</div>
                      <ct-hstack gap="2" style="align-items: center;">
                        <ct-input
                          type="date"
                          $value={scheduleStartDateCell}
                          style="flex: 1.2;"
                        />
                        <ct-select
                          $value={scheduleHourCell}
                          items={hourItems}
                          style="flex: 0.8;"
                        />
                        <span style="font-size: 1.25rem; font-weight: 500; color: #86868b;">
                          :
                        </span>
                        <ct-select
                          $value={scheduleMinuteCell}
                          items={minuteItems}
                          style="flex: 0.8;"
                        />
                        <ct-select
                          $value={schedulePeriodCell}
                          items={periodItems}
                          style="flex: 0.8;"
                        />
                      </ct-hstack>
                    </div>

                    <div className="modal-section">
                      <div className="modal-label">Duration</div>
                      <ct-select
                        $value={scheduleDurationCell}
                        items={durationItems}
                        style="width: 100%;"
                      />
                    </div>

                    <div className="modal-section">
                      <div className="modal-label">Repeats</div>
                      <ct-select
                        $value={scheduleRepeatCell}
                        onChange={onRepeatTypeChange({
                          scheduleRepeatDaysCell,
                          scheduleStartDateCell,
                        })}
                        items={[
                          { value: "none", label: "Does not repeat" },
                          { value: "daily", label: "Daily" },
                          { value: "weekly", label: "Weekly" },
                          { value: "monthly", label: "Monthly" },
                        ]}
                        style="width: 100%;"
                      />
                    </div>

                    {ifElse(
                      derive(scheduleRepeatCell, (repeatType: any) =>
                        repeatType === "weekly"),
                      <div className="modal-section">
                        <div className="modal-label">Repeat on</div>
                        <div className="day-selector-grid">
                          <button
                            type="button"
                            className={derive(
                              scheduleRepeatDaysCell,
                              (days: any) =>
                                days.includes("SU")
                                  ? "day-button selected"
                                  : "day-button",
                            )}
                            onClick={toggleRepeatDay({
                              day: "SU",
                              scheduleRepeatDaysCell,
                            })}
                          >
                            Su
                          </button>
                          <button
                            type="button"
                            className={derive(
                              scheduleRepeatDaysCell,
                              (days: any) =>
                                days.includes("MO")
                                  ? "day-button selected"
                                  : "day-button",
                            )}
                            onClick={toggleRepeatDay({
                              day: "MO",
                              scheduleRepeatDaysCell,
                            })}
                          >
                            Mo
                          </button>
                          <button
                            type="button"
                            className={derive(
                              scheduleRepeatDaysCell,
                              (days: any) =>
                                days.includes("TU")
                                  ? "day-button selected"
                                  : "day-button",
                            )}
                            onClick={toggleRepeatDay({
                              day: "TU",
                              scheduleRepeatDaysCell,
                            })}
                          >
                            Tu
                          </button>
                          <button
                            type="button"
                            className={derive(
                              scheduleRepeatDaysCell,
                              (days: any) =>
                                days.includes("WE")
                                  ? "day-button selected"
                                  : "day-button",
                            )}
                            onClick={toggleRepeatDay({
                              day: "WE",
                              scheduleRepeatDaysCell,
                            })}
                          >
                            We
                          </button>
                          <button
                            type="button"
                            className={derive(
                              scheduleRepeatDaysCell,
                              (days: any) =>
                                days.includes("TH")
                                  ? "day-button selected"
                                  : "day-button",
                            )}
                            onClick={toggleRepeatDay({
                              day: "TH",
                              scheduleRepeatDaysCell,
                            })}
                          >
                            Th
                          </button>
                          <button
                            type="button"
                            className={derive(
                              scheduleRepeatDaysCell,
                              (days: any) =>
                                days.includes("FR")
                                  ? "day-button selected"
                                  : "day-button",
                            )}
                            onClick={toggleRepeatDay({
                              day: "FR",
                              scheduleRepeatDaysCell,
                            })}
                          >
                            Fr
                          </button>
                          <button
                            type="button"
                            className={derive(
                              scheduleRepeatDaysCell,
                              (days: any) =>
                                days.includes("SA")
                                  ? "day-button selected"
                                  : "day-button",
                            )}
                            onClick={toggleRepeatDay({
                              day: "SA",
                              scheduleRepeatDaysCell,
                            })}
                          >
                            Sa
                          </button>
                        </div>
                      </div>,
                      <div></div>,
                    )}

                    {ifElse(
                      derive(scheduleRepeatCell, (repeatType: any) =>
                        repeatType === "monthly"),
                      <div className="modal-section">
                        <div className="modal-label">Monthly Pattern</div>
                        <ct-select
                          $value={scheduleMonthlyPatternCell}
                          items={derive(
                            scheduleStartDateCell,
                            (startDate: any) => {
                              if (!startDate) {
                                return [];
                              }
                              const date = new Date(startDate + "T00:00:00");
                              const dayOfMonth = date.getDate();
                              const dayOfWeek = date.getDay();
                              const dayNames = [
                                "Sunday",
                                "Monday",
                                "Tuesday",
                                "Wednesday",
                                "Thursday",
                                "Friday",
                                "Saturday",
                              ];
                              const dayName = dayNames[dayOfWeek];

                              // Calculate which occurrence of this weekday in the month (1st, 2nd, 3rd, 4th, or last)
                              const weekOfMonth =
                                Math.floor((dayOfMonth - 1) / 7) + 1;
                              const ordinals = [
                                "first",
                                "second",
                                "third",
                                "fourth",
                                "fifth",
                              ];
                              const ordinal = ordinals[weekOfMonth - 1] ||
                                "last";

                              return [
                                {
                                  value: "dayOfMonth",
                                  label: `Monthly on day ${dayOfMonth}`,
                                },
                                {
                                  value: "weekdayOfMonth",
                                  label: `Monthly on the ${ordinal} ${dayName}`,
                                },
                              ];
                            },
                          )}
                          style="width: 100%;"
                        />
                      </div>,
                      <div></div>,
                    )}

                    {ifElse(
                      derive(scheduleRepeatCell, (repeatType: any) =>
                        repeatType !== "none"),
                      <div className="modal-section">
                        <div className="modal-label">Ends</div>
                        <ct-select
                          $value={scheduleRepeatEndsCell}
                          items={[
                            { value: "never", label: "Never" },
                            { value: "on", label: "On date" },
                          ]}
                          style="width: 100%;"
                        />

                        {ifElse(
                          derive(scheduleRepeatEndsCell, (endsType: any) =>
                            endsType === "on"),
                          <div style="margin-top: 12px;">
                            <ct-input
                              type="date"
                              $value={scheduleRepeatUntilCell}
                              style="width: 100%;"
                            />
                          </div>,
                          <div></div>,
                        )}
                      </div>,
                      <div></div>,
                    )}

                    <div className="modal-section">
                      <ct-hstack gap="2" style="align-items: center;">
                        <ct-checkbox $checked={scheduleNotifEnabledCell} />
                        <div className="modal-label" style="margin-bottom: 0;">
                          Enable Notification
                        </div>
                      </ct-hstack>
                    </div>

                    {ifElse(
                      scheduleNotifEnabledCell,
                      <div className="modal-section">
                        <div className="modal-label">Notify me</div>
                        <ct-hstack gap="2" style="align-items: center;">
                          <ct-input
                            type="number"
                            $value={scheduleNotifValueCell}
                            style="width: 80px;"
                          />
                          <ct-select
                            $value={scheduleNotifUnitCell}
                            items={[
                              { value: "minute", label: "minute(s)" },
                              { value: "hour", label: "hour(s)" },
                              { value: "day", label: "day(s)" },
                              { value: "week", label: "week(s)" },
                            ]}
                            style="flex: 1;"
                          />
                          <span style="font-size: 0.875rem; color: #86868b;">
                            before
                          </span>
                        </ct-hstack>
                      </div>,
                      <div></div>,
                    )}

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginTop: "16px",
                        alignItems: "center",
                        width: "100%",
                        gap: "12px",
                      }}
                    >
                      <button
                        type="button"
                        onClick={deleteNoteFromModal({
                          entries,
                          recurringSeries,
                          scheduleModalState,
                          seriesOverrides,
                          deletionConfirmingScopeCell,
                          deletionPendingCell,
                          scheduleEditScopeCell,
                        })}
                        className="delete-modal-button"
                        title="Delete this note"
                        style={{ flex: "0 0 auto" }}
                      >
                        🗑️
                      </button>
                      <ct-button
                        onClick={feelingLucky({
                          entries,
                          recurringSeries,
                          scheduleModalState,
                          scheduleTextCell,
                          scheduleHourCell,
                          scheduleMinuteCell,
                          schedulePeriodCell,
                          scheduleDurationCell,
                          scheduleNotifEnabledCell,
                          scheduleNotifValueCell,
                          scheduleNotifUnitCell,
                          customTimeLabels,
                        })}
                        size="sm"
                        variant="ghost"
                        style={{ flex: "1 1 auto" }}
                      >
                        I'm Feeling Lucky
                      </ct-button>
                      <ct-button
                        onClick={saveSchedule({
                          scheduleModalState,
                          scheduleConfirmingScopeCell,
                          entries,
                          recurringSeries,
                          seriesOverrides,
                          scheduleTextCell,
                          scheduleStartDateCell,
                          scheduleHourCell,
                          scheduleMinuteCell,
                          schedulePeriodCell,
                          scheduleDurationCell,
                          scheduleNotifEnabledCell,
                          scheduleNotifValueCell,
                          scheduleNotifUnitCell,
                          scheduleRepeatCell,
                          scheduleRepeatDaysCell,
                          scheduleMonthlyPatternCell,
                          scheduleRepeatEndsCell,
                          scheduleRepeatUntilCell,
                          scheduleRepeatCountCell,
                          scheduleEditScopeCell,
                        })}
                        size="sm"
                        style={{ flex: "0 0 auto" }}
                      >
                        Save
                      </ct-button>
                    </div>
                  </ct-vstack>,
                )}
              </div>
            </div>,
            <div></div>,
          )}

          {ifElse(
            deletionConfirmingScopeCell,
            <div className="settings-modal">
              <div
                className="settings-content"
                style="max-width: 500px; max-height: 90vh; overflow-y: auto;"
              >
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                  <h3 className="settings-header" style="margin: 0;">
                    Delete Recurring Event?
                  </h3>
                  <button
                    type="button"
                    onClick={cancelDeletionConfirmation({
                      deletionConfirmingScopeCell,
                      deletionPendingCell,
                    })}
                    style="background: none; border: none; font-size: 24px; cursor: pointer; padding: 0; line-height: 1; color: #86868b;"
                  >
                    ×
                  </button>
                </div>

                <ct-vstack gap="3">
                  <div style="text-align: center; padding: 20px 0;">
                    <div style="font-size: 1.125rem; font-weight: 600; margin-bottom: 12px; color: #1d1d1f;">
                      Choose which occurrences to delete
                    </div>
                    <div style="font-size: 0.875rem; color: #86868b;">
                      This action cannot be undone
                    </div>
                  </div>
                  <ct-vstack gap="2" style="padding: 0 2px;">
                    <div
                      onClick={deleteScopeThis({
                        entries,
                        recurringSeries,
                        seriesOverrides,
                        deletionConfirmingScopeCell,
                        deletionPendingCell,
                        scheduleEditScopeCell,
                      })}
                      style="cursor: pointer; width: 100%; padding: 16px; background: white; border: 2px solid #e5e5e7; border-radius: 12px; text-align: left; transition: all 0.2s ease;"
                    >
                      <div style="font-weight: 600; margin-bottom: 4px; color: #1d1d1f;">
                        This event only
                      </div>
                      <div style="font-size: 0.8125rem; color: #86868b;">
                        Only this occurrence will be deleted
                      </div>
                    </div>
                    <div
                      onClick={deleteScopeFuture({
                        entries,
                        recurringSeries,
                        seriesOverrides,
                        deletionConfirmingScopeCell,
                        deletionPendingCell,
                        scheduleEditScopeCell,
                      })}
                      style="cursor: pointer; width: 100%; padding: 16px; background: white; border: 2px solid #e5e5e7; border-radius: 12px; text-align: left; transition: all 0.2s ease;"
                    >
                      <div style="font-weight: 600; margin-bottom: 4px; color: #1d1d1f;">
                        This and future events
                      </div>
                      <div style="font-size: 0.8125rem; color: #86868b;">
                        This and all following occurrences will be deleted
                      </div>
                    </div>
                    <div
                      onClick={deleteScopeAll({
                        entries,
                        recurringSeries,
                        seriesOverrides,
                        deletionConfirmingScopeCell,
                        deletionPendingCell,
                        scheduleEditScopeCell,
                      })}
                      style="cursor: pointer; width: 100%; padding: 16px; background: white; border: 2px solid #e5e5e7; border-radius: 12px; text-align: left; transition: all 0.2s ease;"
                    >
                      <div style="font-weight: 600; margin-bottom: 4px; color: #1d1d1f;">
                        All events in series
                      </div>
                      <div style="font-size: 0.8125rem; color: #86868b;">
                        All past and future occurrences will be deleted
                      </div>
                    </div>
                  </ct-vstack>
                  <ct-button
                    onClick={cancelDeletionConfirmation({
                      deletionConfirmingScopeCell,
                      deletionPendingCell,
                    })}
                    size="sm"
                    variant="ghost"
                    style="margin-top: 12px;"
                  >
                    Cancel
                  </ct-button>
                </ct-vstack>
              </div>
            </div>,
            <div></div>,
          )}

          <div className="main-layout">
            <div className="left-column">
              {ifElse(
                showMonthView,
                <div className="date-picker-container" style="display: none;">
                </div>,
                <div
                  className="date-picker-container"
                  style="display: block; margin-bottom: 16px;"
                >
                  <input
                    type="date"
                    value={currentDate}
                    onChange={handleDateInputChange({ currentDate })}
                    className="date-picker-input"
                  />
                </div>,
              )}

              <div className="column-section">
                <div className="date-nav">
                  <ct-button
                    onClick={previousDay({ currentDate })}
                    size="sm"
                    variant="ghost"
                  >
                    ←
                  </ct-button>
                  <h2>
                    {formattedDate}
                  </h2>
                  <ct-button
                    onClick={nextDay({ currentDate })}
                    size="sm"
                    variant="ghost"
                  >
                    →
                  </ct-button>
                  <ct-button
                    onClick={goToToday({ currentDate, viewedYearMonth })}
                    size="sm"
                    variant="ghost"
                  >
                    Today
                  </ct-button>
                </div>
              </div>

              <div className="column-section">
                <ct-vstack gap="2">
                  <div className="daily-note-header">
                    <label className="daily-note-label">Daily Notes</label>
                    <button
                      type="button"
                      className="add-note-button"
                      onClick={addNote({ entries, currentDate })}
                    >
                      +
                    </button>
                  </div>

                  <ct-vstack gap="1">
                    {/* OPTIMIZATION v12: Pre-computed display values (icon, buttonClass, formattedTime) */}
                    {unifiedTimeline.map((item: any, idx: number) => {
                      const theNote = item.note ||
                        { id: "", text: "", scheduledTime: "", duration: "" };

                      return (
                        <div key={idx}>
                          {/* Ghost slot button */}
                          <button
                            type="button"
                            className="time-slot"
                            style={item.showGhost ? "" : "display: none"}
                            onClick={addNoteAtTime({
                              entries,
                              currentDate,
                              scheduledTime: item.timeStr,
                              duration: item.adaptiveDuration,
                            })}
                            title={`Add note at ${item.displayTime}`}
                          >
                            {item.displayTime}
                          </button>

                          {/* Unscheduled note */}
                          <div
                            className="note-item"
                            style={item.showUnscheduled ? "" : "display: none"}
                          >
                            <ct-hstack gap="1" style="align-items: center;">
                              <input
                                type="text"
                                value={theNote.text || ""}
                                onChange={updateNote({
                                  entries,
                                  currentDate,
                                  noteId: theNote.id,
                                  customTimeLabels,
                                })}
                                placeholder="Write something..."
                                className="note-textarea"
                              />
                              <button
                                type="button"
                                className={item.buttonClass || "clock-button"}
                                title={theNote.seriesId
                                  ? "Recurring event"
                                  : (theNote.notificationEnabled
                                    ? `Scheduled for ${
                                      theNote.scheduledTime || "no time set"
                                    }`
                                    : "Schedule")}
                                onClick={openScheduleModal({
                                  scheduleModalState,
                                  noteId: theNote.id,
                                  currentDate,
                                  entries,
                                  recurringSeries,
                                  scheduleTimeCell,
                                  scheduleTextCell,
                                  scheduleStartDateCell,
                                  scheduleHourCell,
                                  scheduleMinuteCell,
                                  schedulePeriodCell,
                                  scheduleDurationCell,
                                  scheduleNotifEnabledCell,
                                  scheduleNotifValueCell,
                                  scheduleNotifUnitCell,
                                  scheduleRepeatCell,
                                  scheduleRepeatDaysCell,
                                  scheduleRepeatEndsCell,
                                  scheduleRepeatUntilCell,
                                  scheduleRepeatCountCell,
                                  scheduleEditScopeCell,
                                  scheduleConfirmingScopeCell,
                                  scheduleOriginalWeeklyDaysCell,
                                  isNewEventCell,
                                })}
                              >
                                {item.icon || "🕐"}
                              </button>
                              <button
                                type="button"
                                className="delete-note-button"
                                onClick={deleteNote({
                                  entries,
                                  recurringSeries,
                                  seriesOverrides,
                                  currentDate,
                                  noteId: theNote.id,
                                  seriesId: theNote.seriesId,
                                  deletionConfirmingScopeCell,
                                  deletionPendingCell,
                                  scheduleEditScopeCell,
                                })}
                              >
                                ×
                              </button>
                            </ct-hstack>
                          </div>

                          {/* Scheduled note */}
                          <div
                            className="note-item"
                            style={item.showScheduled ? "" : "display: none"}
                          >
                            <ct-hstack gap="1" style="align-items: center;">
                              <span
                                className="note-time"
                                onClick={openScheduleModal({
                                  scheduleModalState,
                                  noteId: theNote.id,
                                  currentDate,
                                  entries,
                                  recurringSeries,
                                  scheduleTimeCell,
                                  scheduleTextCell,
                                  scheduleStartDateCell,
                                  scheduleHourCell,
                                  scheduleMinuteCell,
                                  schedulePeriodCell,
                                  scheduleDurationCell,
                                  scheduleNotifEnabledCell,
                                  scheduleNotifValueCell,
                                  scheduleNotifUnitCell,
                                  scheduleRepeatCell,
                                  scheduleRepeatDaysCell,
                                  scheduleRepeatEndsCell,
                                  scheduleRepeatUntilCell,
                                  scheduleRepeatCountCell,
                                  scheduleEditScopeCell,
                                  scheduleConfirmingScopeCell,
                                  scheduleOriginalWeeklyDaysCell,
                                  isNewEventCell,
                                })}
                              >
                                {item.formattedTime}
                              </span>
                              <input
                                type="text"
                                value={theNote.text || ""}
                                onChange={updateNote({
                                  entries,
                                  currentDate,
                                  noteId: theNote.id,
                                  customTimeLabels,
                                })}
                                placeholder="Write something..."
                                className="note-textarea"
                              />
                              <button
                                type="button"
                                className={item.buttonClass || "clock-button"}
                                title={theNote.seriesId
                                  ? "Recurring event"
                                  : (theNote.notificationEnabled
                                    ? `Scheduled for ${
                                      theNote.scheduledTime || "no time set"
                                    }`
                                    : "Schedule")}
                                onClick={openScheduleModal({
                                  scheduleModalState,
                                  noteId: theNote.id,
                                  currentDate,
                                  entries,
                                  recurringSeries,
                                  scheduleTimeCell,
                                  scheduleTextCell,
                                  scheduleStartDateCell,
                                  scheduleHourCell,
                                  scheduleMinuteCell,
                                  schedulePeriodCell,
                                  scheduleDurationCell,
                                  scheduleNotifEnabledCell,
                                  scheduleNotifValueCell,
                                  scheduleNotifUnitCell,
                                  scheduleRepeatCell,
                                  scheduleRepeatDaysCell,
                                  scheduleRepeatEndsCell,
                                  scheduleRepeatUntilCell,
                                  scheduleRepeatCountCell,
                                  scheduleEditScopeCell,
                                  scheduleConfirmingScopeCell,
                                  scheduleOriginalWeeklyDaysCell,
                                  isNewEventCell,
                                })}
                              >
                                {item.icon || "🕐"}
                              </button>
                              <button
                                type="button"
                                className="delete-note-button"
                                onClick={deleteNote({
                                  entries,
                                  recurringSeries,
                                  seriesOverrides,
                                  currentDate,
                                  noteId: theNote.id,
                                  seriesId: theNote.seriesId,
                                  deletionConfirmingScopeCell,
                                  deletionPendingCell,
                                  scheduleEditScopeCell,
                                })}
                              >
                                ×
                              </button>
                            </ct-hstack>
                          </div>
                        </div>
                      );
                    })}
                  </ct-vstack>
                </ct-vstack>
              </div>
            </div>

            {ifElse(
              showMonthView,
              <div className="right-column">
                <div className="month-header">
                  <ct-button
                    onClick={previousMonth({ currentDate, viewedYearMonth })}
                    size="sm"
                    variant="ghost"
                  >
                    ←
                  </ct-button>
                  {derive(
                    { currentMonth, currentYear },
                    ({ currentMonth, currentYear }: any) => (
                      <h3>
                        {currentMonth} {currentYear}
                      </h3>
                    ),
                  )}
                  <ct-button
                    onClick={nextMonth({ currentDate, viewedYearMonth })}
                    size="sm"
                    variant="ghost"
                  >
                    →
                  </ct-button>
                </div>

                <div className="calendar-grid">
                  <div className="calendar-day-header">Sun</div>
                  <div className="calendar-day-header">Mon</div>
                  <div className="calendar-day-header">Tue</div>
                  <div className="calendar-day-header">Wed</div>
                  <div className="calendar-day-header">Thu</div>
                  <div className="calendar-day-header">Fri</div>
                  <div className="calendar-day-header">Sat</div>

                  {calendarDays.map((dayObj: any) => (
                    <div
                      className={dayObj.className}
                      data-date={dayObj.date}
                      onClick={selectDayHandler}
                    >
                      {dayObj.day}
                    </div>
                  ))}
                </div>
              </div>,
              <div></div>,
            )}
          </div>
        </ct-screen>
      ),
      entries: mergedEntries,
      currentDate,
      name,
      customTimeLabels,
      addEntry: addEntryHandler({ entries, customTimeLabels, recurringSeries }),
      updateEntry: updateEntryHandler({ entries }),
      goToDate: goToDateHandler({ currentDate, viewedYearMonth }),
      rename: renameHandler({ name }),

      // Field setters
      setScheduledTime: setScheduledTimeHandler({
        entries,
        recurringSeries,
        seriesOverrides,
      }),
      setDuration: setDurationHandler({ entries, seriesOverrides }),
      setNotification: setNotificationHandler({ entries, seriesOverrides }),

      // Series management
      createSeries: createSeriesHandler({ recurringSeries }),
      updateSeries: updateSeriesHandler({ recurringSeries }),
      deleteSeries: deleteSeriesHandler({ recurringSeries }),
    };
  },
);
