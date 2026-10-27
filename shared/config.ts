import config from './config.json';
import packageInfo from '../package.json';
export const appVersion = packageInfo.version;
export const defaultOrigin = `https://${config.hostname}:${config.httpsPort}`;
export const productName = 'Relquay';
export const productNameZh = '云渡';
export const productTitle = `${productName} · ${productNameZh}`;
