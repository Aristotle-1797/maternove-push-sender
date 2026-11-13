// Sends reminders that just became due: an in-app notification (shown in the app's
// bell) plus a push notification to the user's registered devices.
// Runs on a schedule (GitHub Actions). Reads only the reminders inside the current
// time window, so it stays inside the free Firestore quota as the app grows.
import admin from "firebase-admin";

const TZ = process.env.APP_TZ || "Africa/Nairobi"; // reminder times are stored as local HH:MM
const LOOKBACK_MIN = 30; // catches reminders if a scheduled run was late or skipped
const NOTIF_DAYS = 30; // in-app notifications are removed after this many days (Firestore TTL on expireAt)

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();
const messaging = admin.messaging();

function localParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const now = new Date();
const a = localParts(new Date(now.getTime() - LOOKBACK_MIN * 60000));
const b = localParts(now);
const windows = a.date === b.date
  ? [{ date: b.date, from: a.time, to: b.time }]
  : [{ date: a.date, from: a.time, to: "23:59" }, { date: b.date, from: "00:00", to: b.time }];

const BODY = {
  medicine: "Time for your medicine.",
  appointment: "You have an appointment reminder.",
  other: "You have a reminder.",
};
const DEAD = ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"];
const ALREADY_EXISTS = 6; // Firestore gRPC code

let sent = 0;
let notified = 0;
for (const w of windows) {
  const snap = await db.collectionGroup("reminders")
    .where("time", ">=", w.from).where("time", "<=", w.to).get();
  console.log(`Window ${w.date} ${w.from}-${w.to}: ${snap.size} reminder(s) with a time in range`);

  for (const d of snap.docs) {
    const r = d.data();
    const slot = `${w.date}T${r.time}`;
    if (r.repeat === "once" && r.date !== w.date) {
      console.log(`Skip "${r.title}": one-off reminder for ${r.date}, not today`);
      continue;
    }
    if (r.lastDone && (r.repeat === "once" || r.lastDone >= w.date)) {
      console.log(`Skip "${r.title}": already marked done`);
      continue;
    }
    if (r.lastPushed && r.lastPushed >= slot) {
      console.log(`Skip "${r.title}": already pushed for ${r.lastPushed}`);
      continue;
    }

    const uid = d.ref.parent.parent.id;
    const title = r.title;
    const body = BODY[r.kind] || BODY.other;

    // 1) In-app notification for the bell. The id is fixed per reminder and time slot,
    //    and create() fails if it exists, so a re-run can never duplicate it
    //    or turn a read notification back into an unread one.
    try {
      await db.collection("users").doc(uid).collection("notifications")
        .doc(`rem-${d.id}-${slot.replace(/[^0-9T]/g, "")}`)
        .create({
          title,
          body,
          kind: "reminder",
          url: "reminders.html",
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + NOTIF_DAYS * 86400000),
        });
      notified++;
    } catch (e) {
      if (e.code !== ALREADY_EXISTS) {
        console.log(`  in-app notification failed for "${title}":`, e.message);
        continue; // nothing recorded, so the next run retries
      }
    }

    // 2) Push to the user's devices, if any are registered
    const devices = await db.collection("users").doc(uid).collection("devices").get();
    let delivered = 0;
    if (devices.empty) {
      console.log(`"${title}" (${slot}): no registered device, in-app notification only`);
    } else {
      const res = await messaging.sendEachForMulticast({
        tokens: devices.docs.map((x) => x.data().token),
        data: { title, body, url: "reminders.html", tag: "rem-" + d.id },
        webpush: { headers: { Urgency: "high", TTL: "3600" } },
      });
      delivered = res.successCount;
      console.log(`"${title}" (${slot}): ${res.successCount} sent, ${res.failureCount} failed`);
      res.responses.forEach((x, i) => {
        if (!x.success) {
          console.log("  push error:", x.error && x.error.code);
          // Remove tokens that no longer work (app uninstalled, permission removed)
          if (x.error && DEAD.includes(x.error.code)) devices.docs[i].ref.delete();
        }
      });
    }

    // The in-app notification exists, so this slot is handled
    await d.ref.update({ lastPushed: slot });
    sent += delivered;
  }
}
console.log(
  `Checked ${windows.length} window(s) in ${TZ}; ${notified} in-app notification(s), ${sent} push message(s) delivered.`,
);
