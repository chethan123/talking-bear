import { Rive } from '@rive-app/canvas-lite';
new Rive({ src: 'bear.riv', canvas: document.querySelector('canvas'), stateMachines: 'Main', autoplay: true });
