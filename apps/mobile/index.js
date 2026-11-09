import { registerRootComponent } from 'expo';
import { installErrorHandler } from './src/error-handler';

// 先安装全局异常捕获，再加载 App，确保 App 模块加载期的异常也能上报。
installErrorHandler();

// eslint-disable-next-line global-require
const App = require('./App').default;

registerRootComponent(App);
