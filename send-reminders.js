// Sends push notifications for reminders that just became due.
// Runs on a schedule (GitHub Actions). Reads only the reminders inside the current
// time window, so it stays inside the free Firestore quota as the app grows.
import admin from "firebase-admin";

const TZ = process.env.APP_TZ || "Africa/Nairobi"; // reminder times are stored as local HH:MM
const LOOKBACK_MIN = 30; // catches reminders if a scheduled run was late or skipped

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

let sent = 0;
for (const w of windows) {
  const snap = await db.collectionGroup("reminders")
    .where("time", ">=", w.from).where("time", "<=", w.to).get();

  for (const d of snap.docs) {
    const r = d.data();
    const slot = `${w.date}T${r.time}`;
    if (r.repeat === "once" && r.date !== w.date) continue;       // not today
    if (r.lastDone && (r.repeat === "once" || r.lastDone >= w.date)) continue; // already done
    if (r.lastPushed && r.lastPushed >= slot) continue;            // already pushed

    const uid = d.ref.parent.parent.id;
    const devices = await db.collection("users").doc(uid).collection("devices").get();
    if (devices.empty) continue;

    const res = await messaging.sendEachForMulticast({
      tokens: devices.docs.map((x) => x.data().token),
      data: { title: r.title, body: BODY[r.kind] || BODY.other, url: "reminders.html", tag: d.id },
      webpush: { headers: { Urgency: "high", TTL: "3600" } },
    });

    // Remove tokens that no longer work (app uninstalled, permission removed)
    res.responses.forEach((x, i) => {
      if (!x.success && x.error && DEAD.includes(x.error.code)) devices.docs[i].ref.delete();
    });

    await d.ref.update({ lastPushed: slot });
    sent += res.successCount;
  }
}
console.log(`Checked ${windows.length} window(s) in ${TZ}; delivered ${sent} push message(s).`);
