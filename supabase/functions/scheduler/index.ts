import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TZ = "America/Sao_Paulo";
const DOW = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function nowBR() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p: Record<string, string> = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute };
}
const utc = (iso: string) => new Date(iso + "T12:00:00Z");
const addDays = (iso: string, n: number) => { const d = utc(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diffDays = (a: string, b: string) => Math.round((utc(b).getTime() - utc(a).getTime()) / 86400000);
const dow = (iso: string) => utc(iso).getUTCDay();
const fmt = (iso: string) => `${DOW[dow(iso)]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const toMin = (t: string) => { const [h, m] = (t || "00:00").split(":"); return +h * 60 + +m; };

function occurs(ev: any, iso: string) {
  if (!ev.date || ev.done || ev._deleted === true) return false;
  if (iso < ev.date) return false;
  const r = ev.recurrence || "none";
  if (r === "none") return iso === ev.date;
  if (r === "daily") return true;
  if (r === "weekly") return diffDays(ev.date, iso) % 7 === 0;
  if (r === "monthly") return ev.date.slice(8, 10) === iso.slice(8, 10);
  return false;
}
const eventsOn = (events: any[], iso: string) => events.filter((e) => occurs(e, iso)).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
const evLine = (e: any) => (e.time && e.time !== "00:00" ? e.time + " " : "") + e.title;

async function loadLegacy(userId: string) {
  const { data, error } = await sb.from("kv").select("key,value").eq("user_id", userId);
  if (error) throw error;
  const m: Record<string, any> = {};
  (data || []).forEach((r: any) => (m[r.key] = r.value));
  return {
    events: Array.isArray(m["agendaplus_events"]) ? m["agendaplus_events"] : [],
    tasks: Array.isArray(m["agendaplus_tasks"]) ? m["agendaplus_tasks"] : [],
    bdays: Array.isArray(m["agendaplus_bdays"]) ? m["agendaplus_bdays"] : [],
  };
}

async function loadNormalized(userId: string) {
  // service_role bypasses RLS, so this explicit owner predicate is mandatory.
  const [itemsResult, settingsResult] = await Promise.all([
    sb.from("agenda_items").select("item_type,item_id,payload").eq("user_id", userId),
    sb.from("kv").select("value").eq("user_id", userId).eq("key", "agendaplus_bdays").maybeSingle(),
  ]);
  if (itemsResult.error) throw itemsResult.error;
  if (settingsResult.error) throw settingsResult.error;
  const events: any[] = [], tasks: any[] = [];
  for (const row of itemsResult.data || []) {
    const payload = row.payload;
    if (!payload || payload._deleted === true) continue; // tombstones are not scheduled
    const item = { ...payload, id: payload.id ?? row.item_id };
    if (row.item_type === "event") events.push(item);
    else if (row.item_type === "task") tasks.push(item);
  }
  const rawBdays = settingsResult.data?.value;
  return { events, tasks, bdays: Array.isArray(rawBdays) ? rawBdays : [] };
}

async function push(userId: string, payload: any, vapid: Record<string, string>) {
  const { data: subs, error } = await sb.from("push_subs").select("*").eq("user_id", userId);
  if (error) throw error;
  let sent = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      sent++;
    } catch (e: any) {
      if (e.statusCode === 404 || e.statusCode === 410) await sb.from("push_subs").delete().eq("endpoint", s.endpoint).eq("user_id", userId);
    }
  }
  return sent;
}

async function once(userId: string, key: string, force: boolean) {
  if (force) return true;
  const { error } = await sb.from("push_log").insert({ user_id: userId, key });
  return !error;
}

Deno.serve(async (req) => {
  try {
    const { data: sec, error: secError } = await sb.from("app_secrets").select("k,v");
    if (secError) throw secError;
    const m: Record<string, string> = {};
    (sec || []).forEach((s: any) => (m[s.k] = s.v));
    if (!m.cron_key || req.headers.get("x-cron-key") !== m.cron_key) return new Response("forbidden", { status: 403 });

    const body = await req.json().catch(() => ({}));
    const mode = body.mode as string, force = !!body.force, dry = !!body.dry;
    webpush.setVapidDetails("mailto:elias.g.alameda@gmail.com", m.vapid_public, m.vapid_private);

    // Fail closed on flag read errors; do not silently use stale legacy schedules after cutover.
    const { data: control, error: controlError } = await sb.from("agenda_sync_control").select("enabled").eq("singleton", true).maybeSingle();
    if (controlError) throw controlError;
    if (!control) throw new Error("agenda_sync_control_missing");
    const normalizedEnabled = control.enabled === true;
    const { data: us, error: usersError } = await sb.from("push_subs").select("user_id");
    if (usersError) throw usersError;
    const users = [...new Set((us || []).map((x: any) => x.user_id))];
    const out: any[] = [];
    const now = nowBR();

    for (const uid of users) {
      const { events, tasks, bdays } = normalizedEnabled ? await loadNormalized(uid) : await loadLegacy(uid);
      const open = tasks.filter((t: any) => t.status !== "done" && t._deleted !== true);
      const overdue = open.filter((t: any) => t.deadline && t.deadline < now.date);

      if (mode === "morning") {
        const evs = eventsOn(events, now.date);
        const dueToday = open.filter((t: any) => t.deadline === now.date);
        const bd = bdays.filter((b: any) => { const md = (b.date || "").slice(5); for (let i = 0; i <= 3; i++) if (addDays(now.date, i).slice(5) === md) return true; return false; });
        const { count, error: inboxError } = await sb.from("agent_inbox").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("status", "pending");
        if (inboxError) throw inboxError;
        const lines: string[] = [];
        const plural = (n: number, a: string, b: string) => (n === 1 ? a : b);
        if (evs.length) {
          lines.push(`${evs.length} ${plural(evs.length, "compromisso", "compromissos")} hoje`);
          evs.slice(0, 4).forEach((e: any) => lines.push("• " + evLine(e)));
          if (evs.length > 4) lines.push(`+ ${evs.length - 4} no app`);
        }
        if (dueToday.length) lines.push(`${dueToday.length} ${plural(dueToday.length, "tarefa", "tarefas")} com prazo hoje: ` + dueToday.slice(0, 2).map((t: any) => t.title).join(", "));
        if (overdue.length) lines.push(`${overdue.length} ${plural(overdue.length, "tarefa atrasada", "tarefas atrasadas")}`);
        if (bd.length) lines.push("Aniversário: " + bd.map((b: any) => b.name).join(", "));
        if (count) lines.push(`${count} ${plural(count, "sugestão", "sugestões")} para confirmar`);
        const payload = { title: `Bom dia · ${fmt(now.date)}`, body: lines.length ? lines.join("\n") : "Dia livre. Aproveite!", url: "./", tag: "morning", image: "banner-morning.jpg" };
        if (dry) { out.push(payload); continue; }
        if (await once(uid, "morning-" + now.date, force)) out.push({ mode, sent: await push(uid, payload, m) });
      }

      if (mode === "reminders") {
        for (const off of [0, 1]) {
          const day = addDays(now.date, off);
          for (const e of eventsOn(events, day)) {
            if (!e.time || e.time === "00:00") continue;
            const diff = off * 1440 + toMin(e.time) - now.mins;
            if (diff > 50 && diff <= 65) {
              const payload = { title: e.title, body: `Começa às ${e.time}, em 1 hora${e.desc ? "\n" + e.desc : ""}`, url: "./", tag: "rem-" + e.id, image: "banner-reminder.jpg" };
              if (dry) { out.push(payload); continue; }
              if (await once(uid, `rem-${e.id}-${day}`, force)) out.push({ mode, sent: await push(uid, payload, m), ev: e.title });
            }
          }
        }
      }

      if (mode === "weekly") {
        const from = addDays(now.date, -6);
        let past = 0;
        for (let i = 0; i < 7; i++) past += eventsOn(events, addDays(from, i)).length;
        const { data: snap, error: snapError } = await sb.from("week_state").select("done_ids").eq("user_id", uid).maybeSingle();
        if (snapError) throw snapError;
        const doneNow = tasks.filter((t: any) => t.status === "done" && t._deleted !== true);
        const prev = new Set((snap?.done_ids as string[]) || []);
        const finished = snap ? doneNow.filter((t: any) => !prev.has(t.id)) : doneNow.filter((t: any) => t.deadline && t.deadline >= from && t.deadline <= now.date);
        const next: string[] = [];
        let nextCount = 0;
        for (let i = 1; i <= 7; i++) { const d = addDays(now.date, i); const l = eventsOn(events, d); nextCount += l.length; l.filter((e: any) => !e.recurrence || e.recurrence === "none").forEach((e: any) => next.push(`${fmt(d)} ${evLine(e)}`)); }
        const nextTasks = open.filter((t: any) => t.deadline && t.deadline > now.date && t.deadline <= addDays(now.date, 7));
        const lines = [
          `${finished.length} ${finished.length === 1 ? "tarefa concluída" : "tarefas concluídas"}${finished.length ? ": " + finished.slice(0, 2).map((t: any) => t.title).join(", ") : ""}`,
          `${past} ${past === 1 ? "compromisso" : "compromissos"} na semana`,
          overdue.length ? `Ficou para trás: ${overdue.slice(0, 2).map((t: any) => t.title).join(", ")}${overdue.length > 2 ? ` +${overdue.length - 2}` : ""}` : "Nada atrasado",
          `Próximos 7 dias: ${nextCount} ${nextCount === 1 ? "compromisso" : "compromissos"}, ${nextTasks.length} ${nextTasks.length === 1 ? "prazo" : "prazos"}`,
        ];
        const payload = { title: "Revisão da semana", body: lines.join("\n"), url: "./", tag: "weekly", image: "banner-weekly.jpg" };
        if (dry) { out.push(payload); continue; }
        if (await once(uid, "weekly-" + now.date, force)) {
          out.push({ mode, sent: await push(uid, payload, m) });
          const { error: updateError } = await sb.from("week_state").upsert({ user_id: uid, done_ids: doneNow.map((t: any) => t.id), updated_at: new Date().toISOString() });
          if (updateError) throw updateError;
        }
      }
    }
    return new Response(JSON.stringify({ mode, now, users: users.length, out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response("err " + e, { status: 500 });
  }
});
