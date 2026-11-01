const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

function configuration() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    const error = new Error("BACKGROUND_TASK_STORAGE_UNAVAILABLE");
    error.code = "BACKGROUND_TASK_STORAGE_UNAVAILABLE";
    throw error;
  }
  return {
    base: SUPABASE_URL.replace(/\/+$/, ""),
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: "Bearer " + SUPABASE_SECRET_KEY,
      "Content-Type": "application/json"
    }
  };
}

async function request(path, options = {}) {
  const config = configuration();
  const response = await fetch(config.base + path, {
    ...options,
    headers: { ...config.headers, ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(10000)
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); }
    catch (_) {
      const error = new Error("BACKGROUND_TASK_INVALID_STORAGE_RESPONSE");
      error.code = "BACKGROUND_TASK_INVALID_STORAGE_RESPONSE";
      throw error;
    }
  }
  if (!response.ok) {
    const error = new Error("BACKGROUND_TASK_STORAGE_ERROR");
    error.code = "BACKGROUND_TASK_STORAGE_ERROR";
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

async function rpc(name, body) {
  return request("/rest/v1/rpc/" + name, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function enqueue(userId, taskRequest, title, idempotencyKey) {
  const result = await rpc("jarvis_enqueue_background_task", {
    p_user_id: userId,
    p_request: taskRequest,
    p_title: title,
    p_idempotency_key: idempotencyKey
  });
  return Array.isArray(result) ? result[0] : result;
}

async function listForUser(userId, limit = 10) {
  const query = new URLSearchParams({
    select: "id,title,status,progress,current_step,plan,error_code,error_message,created_at,updated_at,completed_at",
    user_id: "eq." + userId,
    order: "created_at.desc",
    limit: String(Math.max(1, Math.min(limit, 20)))
  });
  const tasks = await request("/rest/v1/jarvis_background_tasks?" + query.toString());
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const ids = tasks.map(task => task.id);
  const stepsQuery = new URLSearchParams({
    select: "task_id,step_index,title,status,error_code",
    task_id: "in.(" + ids.join(",") + ")",
    order: "step_index.asc"
  });
  const steps = await request("/rest/v1/jarvis_background_task_steps?" + stepsQuery.toString());
  const byTask = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!byTask.has(step.task_id)) byTask.set(step.task_id, []);
    byTask.get(step.task_id).push(step);
  }
  return tasks.map(task => ({ ...task, steps: byTask.get(task.id) || [] }));
}

async function getForUser(userId, taskId) {
  const query = new URLSearchParams({
    select: "*",
    id: "eq." + taskId,
    user_id: "eq." + userId,
    limit: "1"
  });
  const rows = await request("/rest/v1/jarvis_background_tasks?" + query.toString());
  if (!Array.isArray(rows) || !rows[0]) return null;
  const [steps, events] = await Promise.all([
    request("/rest/v1/jarvis_background_task_steps?" + new URLSearchParams({
      select: "step_index,title,instruction,status,output,error_code,attempt_count,started_at,completed_at",
      task_id: "eq." + taskId,
      order: "step_index.asc"
    }).toString()),
    request("/rest/v1/jarvis_background_task_events?" + new URLSearchParams({
      select: "event_type,message,payload,created_at,read_at",
      task_id: "eq." + taskId,
      user_id: "eq." + userId,
      order: "created_at.asc",
      limit: "50"
    }).toString())
  ]);
  return { task: rows[0], steps: Array.isArray(steps) ? steps : [], events: Array.isArray(events) ? events : [] };
}

async function cancel(userId, taskId) {
  return rpc("jarvis_cancel_background_task", {
    p_user_id: userId,
    p_task_id: taskId
  });
}

async function pause(userId, taskId) {
  return rpc("jarvis_pause_background_task", {
    p_user_id: userId,
    p_task_id: taskId
  });
}

async function resume(userId, taskId) {
  return rpc("jarvis_resume_background_task", {
    p_user_id: userId,
    p_task_id: taskId
  });
}

async function releaseLease(taskId, workerId) {
  return rpc("jarvis_release_background_task_lease", {
    p_task_id: taskId,
    p_worker_id: workerId
  });
}

async function claim(workerId, leaseSeconds = 120) {
  const result = await rpc("jarvis_claim_background_task", {
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds
  });
  return Array.isArray(result) ? result[0] || null : result || null;
}

async function savePlan(taskId, workerId, plan) {
  return rpc("jarvis_save_background_task_plan", {
    p_task_id: taskId,
    p_worker_id: workerId,
    p_plan: plan
  });
}

async function saveStep(taskId, workerId, stepIndex, output, progress, nextStatus = "queued") {
  return rpc("jarvis_save_background_task_step", {
    p_task_id: taskId,
    p_worker_id: workerId,
    p_step_index: stepIndex,
    p_output: output,
    p_progress: progress,
    p_next_status: nextStatus
  });
}

async function appendCorrection(taskId, workerId, title, instruction) {
  return rpc("jarvis_append_background_task_correction", {
    p_task_id: taskId,
    p_worker_id: workerId,
    p_title: title,
    p_instruction: instruction
  });
}

async function finish(taskId, workerId, status, result = null, errorCode = null, errorMessage = null, runAfter = null) {
  return rpc("jarvis_finish_background_task", {
    p_task_id: taskId,
    p_worker_id: workerId,
    p_status: status,
    p_result: result,
    p_error_code: errorCode,
    p_error_message: errorMessage,
    p_run_after: runAfter
  });
}

async function getStepsForWorker(taskId) {
  const query = new URLSearchParams({
    select: "step_index,title,instruction,status,output",
    task_id: "eq." + taskId,
    order: "step_index.asc"
  });
  return request("/rest/v1/jarvis_background_task_steps?" + query.toString());
}

module.exports = {
  enqueue,
  listForUser,
  getForUser,
  cancel,
  pause,
  resume,
  releaseLease,
  claim,
  savePlan,
  saveStep,
  appendCorrection,
  finish,
  getStepsForWorker
};
