/**
 * Фасад над локальной сборкой @joint/core@4.3.4 (MPL-2.0).
 * Сам бандл — classic script vendor/joint/joint.min.js: его нужно подключить
 * до Monaco, иначе AMD-loader редактора перехватит UMD и globalThis.joint не появится.
 * CDN не используем: страница под COEP (coi-serviceworker.js) не грузит чужие скрипты без CORP.
 */
const joint = globalThis.joint;

if (!joint?.dia?.Graph || !joint?.shapes?.standard?.Link || !joint?.elementTools || !joint?.linkTools) {
  throw new Error(
    'JointJS (@joint/core 4.3.4) не загружен. Скрипт vendor/joint/joint.min.js должен идти до Monaco.',
  );
}

export const dia = joint.dia;
export const shapes = joint.shapes;
export const elementTools = joint.elementTools;
export const linkTools = joint.linkTools;
export const version = joint.version;

export default joint;
