
const functions = require('firebase-functions');
const admin = require('firebase-admin');
try { admin.initializeApp(); } catch (_) {}

const db = admin.firestore();

async function recomputeRanking() {
  // Soma total de pontos por tribo em pontos_semanais
  const pontosSnap = await db.collection('pontos_semanais').get();
  const totalPorTribo = {};
  pontosSnap.forEach(doc => {
    const {tribo, pontos} = doc.data();
    if (!tribo) return;
    const p = Number(pontos) || 0;
    totalPorTribo[tribo] = (totalPorTribo[tribo] || 0) + p;
  });
  // salva em ranking_total/{tribo}
  const batch = db.batch();
  Object.entries(totalPorTribo).forEach(([tribo, total]) => {
    const ref = db.collection('ranking_total').doc(tribo);
    batch.set(ref, { total, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
  await batch.commit();
}

async function recomputePresencasAgg() {
  // Agrega presenças por semana
  const semSnap = await db.collection('semanas').orderBy('ordem').get();
  const semanas = semSnap.docs.map(d => d.data().nome || d.id);
  const mapa = {}; // semana -> {presente, ausente}
  semanas.forEach(s => mapa[s] = {presente:0, ausente:0});

  const presSnap = await db.collection('presencas_semanais').get();
  presSnap.forEach(doc => {
    const {semana, presente, ausente} = doc.data();
    if (!semana || !mapa[semana]) return;
    mapa[semana].presente += Number(presente) || 0;
    mapa[semana].ausente  += Number(ausente)  || 0;
  });

  // salva agregados numa coleção 'presencas_semanais_agg'
  const batch = db.batch();
  Object.entries(mapa).forEach(([semana, v]) => {
    const ref = db.collection('presencas_semanais_agg').doc(semana);
    batch.set(ref, { semana, presente: v.presente, ausente: v.ausente, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
  await batch.commit();

  // faltas agregadas (exemplo simples somando ausências)
  let faltas = 0, justificadas = 0;
  // Se você tiver a coleção 'faltas' com {justificada:boolean}, agregue aqui. Mantemos exemplo básico:
  Object.values(mapa).forEach(v => { faltas += v.ausente; });
  await db.collection('faltas_agregado').doc('default').set({
    faltas, justificadas, atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

// Triggers: quando pontos ou presenças mudarem, recalcule agregados
exports.onPontosChange = functions.firestore
  .document('pontos_semanais/{id}')
  .onWrite(async (change, context) => {
    await recomputeRanking();
  });

exports.onPresencasChange = functions.firestore
  .document('presencas_semanais/{id}')
  .onWrite(async (change, context) => {
    await recomputePresencasAgg();
  });

// Funções chamáveis para rodar manualmente do painel (se quiser)
exports.recomputeAll = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Faça login para executar');
  }
  // Papel básico via Firestore
  const email = context.auth.token.email;
  const doc = await db.collection('usuarios').doc(email).get();
  const papel = doc.exists ? (doc.data().papel || 'viewer') : 'viewer';
  if (papel !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'Apenas administradores');
  }
  await recomputeRanking();
  await recomputePresencasAgg();
  return { ok: true };
});
