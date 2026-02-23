import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { createEvent } from "ics";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;


app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// Data files 
const FILE_APPTS = "./appointments.json";
const FILE_BLOCKS = "./blocks.json";

// Ensure data files exist
if (!fs.existsSync(FILE_APPTS)) fs.writeFileSync(FILE_APPTS, "[]");
if (!fs.existsSync(FILE_BLOCKS)) fs.writeFileSync(FILE_BLOCKS, "[]");

// Helpers
const readJSON = (p) => JSON.parse(fs.readFileSync(p));
const writeJSON = (p, data) => fs.writeFileSync(p, JSON.stringify(data, null, 2));
const genId = () => Math.random().toString(36).slice(2, 10);

function toISO(dt) {
  try { return new Date(dt).toISOString(); } catch { return null; }
}

//  Gmail
function makeTransport() {
  const provider = (process.env.SMTP_PROVIDER || "gmail").toLowerCase();

  if (provider === "mailtrap") {
    return nodemailer.createTransport({
      host: process.env.MAILTRAP_HOST || "sandbox.smtp.mailtrap.io",
      port: Number(process.env.MAILTRAP_PORT || 587),
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }

  // Gmail (requires an App Password on the Gmail account)
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

const transporter = makeTransport();

// Verify SMTP 
transporter.verify((err, success) => {
  if (err) {
    console.error("❌ SMTP verify failed:", err.message);
  } else {
    console.log("✅ SMTP ready to send emails");
  }
});

// Small helper to always log success/failure
async function sendEmail(options) {
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER, // sender must match auth user for Gmail
      ...options,
    });
    console.log("✉️  sent:", info.messageId, "to:", options.to);
    return { ok: true };
  } catch (e) {
    console.error("❌ send failed to", options.to, "->", e.message);
    return { ok: false, error: e.message };
  }
}

// Quick env debug route
app.get("/api/debug-env", (req, res) => {
  const pass = process.env.EMAIL_PASS || "";
  res.json({
    SMTP_PROVIDER: process.env.SMTP_PROVIDER || "gmail",
    EMAIL_USER: process.env.EMAIL_USER || "(missing)",
    EMAIL_PASS_LEN: pass.length,
    TEACHER_EMAIL: process.env.TEACHER_EMAIL || "(missing)",
    EMAIL_FROM: process.env.EMAIL_FROM || "(default: EMAIL_USER)",
  });
});

//Availability (excludes booked slots) 
function slotISO(day, hour) {
  // day format: YYYY-MM-DD; interpret as local then to ISO
  return new Date(`${day}T${String(hour).padStart(2, "0")}:00:00`).toISOString();
}

function isTaken(appt) {
  // A slot is considered taken if status is NOT rejected or cancelled
  return appt.status !== "rejected" && appt.status !== "cancelled";
}

// Simple availability: hourly slots 10:00–16:00
app.get("/api/availability", (req, res) => {
  const { day } = req.query; // YYYY-MM-DD
  if (!day) return res.status(400).json({ error: "Missing date" });

  const hours = [10, 11, 12, 13, 14, 15, 16];
  const appts = readJSON(FILE_APPTS);

  const takenSet = new Set(
    appts.filter(isTaken).map((a) => new Date(a.startUtc).toISOString())
  );

  const available = hours
    .map((h) => slotISO(day, h))
    .filter((iso) => !takenSet.has(iso));

  res.json({ day, available });
});

// ICS helper 
function icsFromISO(iso, title = "Math Tutoring Session", desc = "1-hour math tutoring session") {
  const d = new Date(iso);
  if (isNaN(d)) return { error: new Error("Bad datetime") };
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();

  const { error, value } = createEvent({
    start: [y, mo, day, hh, mm],
    startInputType: "utc",
    duration: { hours: 1 },
    title,
    description: desc,
    status: "CONFIRMED",
    // location: "Online (meeting link will be sent)",
    // url: "https://your-meeting-link",
  });
  return { error, ics: value };
}

// Student booking 
app.post("/api/book", async (req, res) => {
  console.log("📩 /api/book called with body:", req.body);

  const { name, email, datetimeLocalISO, timezone, subject = "Math" } = req.body;

  // Basic validation
  if (!name || !email || !datetimeLocalISO) {
    console.log("❌ Missing required fields");
    return res.status(400).json({ ok: false, error: "Missing required fields" });
  }

  const startUtc = toISO(datetimeLocalISO);
  if (!startUtc) {
    console.log("❌ Bad datetime:", datetimeLocalISO);
    return res.status(400).json({ ok: false, error: "Bad datetime" });
  }

  const appts = readJSON(FILE_APPTS);

  // Prevent double-booking the exact slot
  const conflict = appts.find(
    (a) =>
      new Date(a.startUtc).toISOString() === new Date(startUtc).toISOString() &&
      isTaken(a)
  );
  if (conflict) {
    console.log("❌ Conflict for slot:", startUtc);
    return res
      .status(409)
      .json({ ok: false, error: "This slot is no longer available." });
  }

  const id = genId();
  const appt = {
    id,
    name,
    email, // student's email (varies per booking)
    subject,
    timezone: timezone || "",
    startUtc,
    status: "pending",
    created: new Date().toISOString(),
    reminderSent: false,
  };

  appts.push(appt);
  writeJSON(FILE_APPTS, appts);
  console.log("✅ Appointment saved:", appt);

  // Build manage link for student
  const base = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  const manageUrl = `${base}/manage.html?id=${id}`;
  const localWhen = new Date(startUtc).toLocaleString();

  // Create ICS (best-effort)
  const { error: icsErr, ics } = icsFromISO(
    startUtc,
    "Math Tutoring Session",
    "1-hour math tutoring session"
  );
  if (icsErr) console.warn("ICS creation warning:", icsErr.message);

  // 1) Email to student – booking REQUEST
  const r1 = await sendEmail({
    to: email,
    subject: "Your math session booking request has been received",
    text: `Hi ${name},

Your request to book a 1-hour Math session on ${localWhen}${
      timezone ? " (" + timezone + ")" : ""
    } has been received.

This is a request only – your tutor still needs to approve this time.
You will receive another email once your tutor has ACCEPTED or REJECTED this time slot.

You can cancel or reschedule (at least 24 hours before the session) using this link:
${manageUrl}

– Your Math Tutor`,
    attachments: ics ? [{ filename: "session.ics", content: ics }] : undefined,
  });
  console.log("📧 result student email:", r1);

  // 2) Email to teacher – new request
  const teacherEmail = process.env.TEACHER_EMAIL || process.env.EMAIL_USER;

  const r2 = await sendEmail({
    to: teacherEmail,
    subject: "New math session booking request",
    text: `You have a new booking request.

Student: ${name}
Email: ${email}
Requested time: ${localWhen}${timezone ? " (" + timezone + ")" : ""}
Subject: ${subject}

Please open the Teacher Admin Panel to APPROVE or REJECT this request.`,
    attachments: ics ? [{ filename: "session.ics", content: ics }] : undefined,
  });
  console.log("📧 result teacher email:", r2);

  if (!r1.ok || !r2.ok) {
    console.log("❌ Email send failed", { r1, r2 });
    return res.status(500).json({
      ok: false,
      error: "Email send failed",
      details: { studentEmail: r1, teacherEmail: r2 },
    });
  }

  res.json({ ok: true, id });
});


// Admin 
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password !== (process.env.ADMIN_PASSWORD || "Rahul@123")) {
    return res.json({ ok: false, error: "Invalid password" });
  }
  res.json({ ok: true });
});
app.get("/api/admin/appointments", (req, res) => {
  const { status } = req.query;
  const appts = readJSON(FILE_APPTS);
  const filtered = status ? appts.filter((a) => a.status === status) : appts;
  res.json({ appointments: filtered });
});
app.post("/api/admin/appointments/:id/status", async (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // "approve" | "reject"
  const appts = readJSON(FILE_APPTS);
  const appt = appts.find((a) => a.id === id);
  if (!appt) return res.status(404).json({ ok: false, error: "Not found" });
  if (action === "approve") appt.status = "approved";
  else if (action === "reject") appt.status = "rejected";
  else return res.status(400).json({ ok: false, error: "Bad action" });
  writeJSON(FILE_APPTS, appts);
  const base = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  const manageUrl = `${base}/manage.html?id=${appt.id}`;
  const localWhen = new Date(appt.startUtc).toLocaleString();
  let attachments;
  if (action === "approve") {
    const { error: icsErr, ics } = icsFromISO(appt.startUtc);
    if (!icsErr && ics) attachments = [{ filename: "session.ics", content: ics }];
  }
  const subject =
    action === "approve"
      ? "Your math session has been ACCEPTED ✅"
      : "Your math session request was REJECTED ❌";
  const text =
    action === "approve"
      ? `Hi ${appt.name},

Good news! Your math session request has been ACCEPTED.

Date & time: ${localWhen}${appt.timezone ? " (" + appt.timezone + ")" : ""}

If you need to cancel or reschedule (at least 24 hours before the session), use this link:
${manageUrl}

– Your Math Tutor`
      : `Hi ${appt.name},

Your math session request for ${localWhen}${
          appt.timezone ? " (" + appt.timezone + ")" : ""
        } has been REJECTED.

Please visit the booking page and choose another date and time that works for you:
${base}/

If you already have a manage link, you can also use it:
${manageUrl}

– Your Math Tutor`;

  const mail = {
    to: appt.email,
    subject,
    text,
    attachments,
  };

  const r = await sendEmail(mail);
  if (!r.ok)
    return res
      .status(500)
      .json({ ok: false, error: "Failed to send decision email" });

  res.json({ ok: true });
});


//. Student Manage (view/cancel/reschedule)
app.get("/api/manage/:id", (req, res) => {
  const appts = readJSON(FILE_APPTS);
  const appt = appts.find((a) => a.id === req.params.id);
  if (!appt) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, appointment: appt });
});

function ensure24hAhead(targetISO) {
  const now = new Date();
  const t = new Date(targetISO);
  const diffHrs = (t - now) / 36e5;
  return diffHrs >= 24;
}

app.post("/api/manage/:id/cancel", (req, res) => {
  const appts = readJSON(FILE_APPTS);
  const appt = appts.find((a) => a.id === req.params.id);
  if (!appt) return res.status(404).json({ ok: false, error: "Not found" });

  if (!ensure24hAhead(appt.startUtc)) {
    return res.status(400).json({ ok: false, error: "Cancellations must be ≥ 24 hours in advance." });
  }
  if (appt.status === "cancelled") {
    return res.json({ ok: true, message: "Already cancelled" });
  }

  appt.status = "cancelled";
  writeJSON(FILE_APPTS, appts);
  res.json({ ok: true });
});

app.post("/api/manage/:id/reschedule", (req, res) => {
  const { newDateTime } = req.body; // from <input type="datetime-local">
  if (!newDateTime) return res.status(400).json({ ok: false, error: "Missing new datetime" });

  const appts = readJSON(FILE_APPTS);
  const appt = appts.find((a) => a.id === req.params.id);
  if (!appt) return res.status(404).json({ ok: false, error: "Not found" });

  if (!ensure24hAhead(appt.startUtc)) {
    return res.status(400).json({ ok: false, error: "Reschedules must be ≥ 24 hours in advance." });
  }

  const newISO = toISO(newDateTime);
  if (!newISO) return res.status(400).json({ ok: false, error: "Bad new datetime" });

  // Conflict check
  const conflict = appts.find(
    (a) => a.id !== appt.id && new Date(a.startUtc).toISOString() === new Date(newISO).toISOString() && isTaken(a)
  );
  if (conflict) {
    return res.status(409).json({ ok: false, error: "That new time is already taken." });
  }

  // When rescheduling, set pending again (teacher must re-approve)
  appt.startUtc = newISO;
  appt.status = "pending";
  writeJSON(FILE_APPTS, appts);
  res.json({ ok: true });
});

// 48h reminders (manual trigger)
app.get("/api/admin/send-reminders", async (req, res) => {
  const appts = readJSON(FILE_APPTS);
  const now = new Date();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

  const due = appts.filter((a) => {
    if (a.status !== "approved" || a.reminderSent) return false;
    const diff = new Date(a.startUtc) - now;
    return diff > 0 && diff <= twoDaysMs;
  });

  let sent = 0;
  for (const a of due) {
    const r = await sendEmail({
      to: a.email,
      subject: "Reminder: Math Session in 2 Days",
      text: `Hi ${a.name},\n\nThis is a reminder for your math session on ${new Date(a.startUtc).toLocaleString()}.\n\n– Your Tutor`,
    });
    if (r.ok) {
      a.reminderSent = true;
      sent++;
    }
  }
  writeJSON(FILE_APPTS, appts);

  res.json({ ok: true, count: sent });
});

// Test email route 
app.get("/api/test-email", async (req, res) => {
  const to = req.query.to || process.env.EMAIL_USER;
  const r = await sendEmail({
    to,
    subject: "Test – Math Booking",
    text: "If you can read this, SMTP is working ✅",
  });
  if (!r.ok) return res.status(500).json(r);
  res.json({ ok: true });
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
