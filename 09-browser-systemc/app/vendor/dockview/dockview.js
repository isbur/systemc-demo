/**
 * Фасад над локальной сборкой dockview@8.9.0 (MIT).
 * UMD-файл vendor/dockview/dockview.min.js подключается classic-скриптом
 * до Monaco: loader.js объявляет AMD define и иначе перехватит бандл.
 * CDN не используем — страница под COEP.
 */
const dockview = globalThis.dockview;

if (!dockview?.createDockview || !dockview?.themeAbyss) {
  throw new Error(
    'Dockview 8.9.0 не загружен. Скрипт vendor/dockview/dockview.min.js должен идти до Monaco.',
  );
}

export const createDockview = dockview.createDockview;
export const themeAbyss = dockview.themeAbyss;
export const version = '8.9.0';
