import assert from 'node:assert/strict';
import { collectStudioImages, imageCommentPrompt, imageEditEffectivePrompt, imagePoint, clampImageZoom, supportsImageStudio, resolveStudioActivePath } from '../../src/ui/utils/image-studio';
import { withGeneratedMediaInput } from '../../src/shared/generated-media';
import { useComposerQueueStore } from '../../src/ui/store/useComposerQueueStore';
import type { StreamMessage } from '../../src/ui/types';
const messages = [
  { type: 'user_prompt', prompt: 'First', createdAt: 1000 },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'imagegen', input: withGeneratedMediaInput({}, [{kind:'image',path:'/tmp/a/output.png'},{kind:'image',path:'/tmp/b/output.png'}]) }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '![image](/tmp/a/output.png)' }] } },
  { type: 'user_prompt', prompt: 'Second', createdAt: 2000 },
  { type: 'assistant', message: { content: [{ type: 'text', text: '![edited](<images/final image.png>) ![remote](https://example.com/no.png)' }] } },
  { type: 'assistant', parentToolUseId: 'child', message: { content: [{ type: 'text', text: '![child](/tmp/child.png)' }] } },
  { type: 'user', message: { content: [{ type: 'text', text: '![user](/tmp/user.png)' }] } },
] as StreamMessage[];
const images = collectStudioImages(messages, '/tmp/project');
assert.deepEqual(images.map(i => i.path), ['/tmp/a/output.png','/tmp/b/output.png','/tmp/project/images/final image.png']);
assert.equal(images[0].turnId, images[1].turnId);
assert.notEqual(images[1].turnId, images[2].turnId);
assert.equal(images[2].createdAt, 2000);
assert.equal(supportsImageStudio('codex'),true);
assert.equal(supportsImageStudio('grok'),true);
assert.equal(supportsImageStudio('claude'),false);
assert.deepEqual(imagePoint(150, 75, {left:50,top:25,width:200,height:100}), {x:.5,y:.5});
assert.deepEqual(imagePoint(-1,200,{left:0,top:0,width:100,height:100}), {x:0,y:1});
assert.equal(clampImageZoom(999),400);
assert.equal(clampImageZoom(0),10);
const comments = { '/b.png': [{ id:'1', x:.25, y:.75, text:'Remove this object' }] };
assert.equal(imageCommentPrompt(['/a.png','/b.png'],comments,'Keep the colors'), 'Image 2:\n1. (x: 25%, y: 75%) Remove this object\n\nAdditional instructions:\nKeep the colors');
assert.match(imageEditEffectivePrompt('grok','Edit',['/a.png']), /^\/imagine /);
assert.match(imageEditEffectivePrompt('codex','Edit',['/a.png']), /preserve the originals/);
const queue = useComposerQueueStore.getState();
const item = (id: string, exclusive = false) => ({id,exclusive,displayPrompt:id,effectivePrompt:id,attachments:[],references:{}});
queue.enqueue('test',item('normal'));
queue.enqueue('test',item('image',true));
queue.enqueue('test',item('next'));
assert.deepEqual(queue.takeNextBatch('test').map(i=>i.id),['normal']);
assert.deepEqual(queue.takeNextBatch('test').map(i=>i.id),['image']);
assert.deepEqual(queue.takeNextBatch('test').map(i=>i.id),['next']);
console.log('image studio: turn grouping, local paths, annotations, provider routing and isolated queue batches passed');

// Grok stores generated images outside cwd and embeds short paths in its reply.
const output = (id: string, path: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'image_gen', input: withGeneratedMediaInput({}, [{ kind: 'image', path }]) }] } });
const markdown = (src: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `![image](${src})` }] } });
const grokRoot = '/home/me/.grok/sessions/%2Fproject%20dir/thread/images';
const grokMessages = [
  { type: 'user_prompt', prompt: 'Cat', createdAt: 1000 }, output('1', `${grokRoot}/1.jpg`), markdown('images/1.jpg'),
  { type: 'user_prompt', prompt: 'Black cat', createdAt: 2000 }, output('2', `${grokRoot}/2.jpg`), markdown('./images/2.jpg'),
] as StreamMessage[];
const grokImages = collectStudioImages(grokMessages, '/project');
assert.deepEqual(grokImages.map(image => image.path), [`${grokRoot}/1.jpg`, `${grokRoot}/2.jpg`]);
assert.equal(resolveStudioActivePath('/project/images/1.jpg', grokImages, '/project'), `${grokRoot}/1.jpg`);
assert.equal(resolveStudioActivePath('/project/other.jpg', grokImages, '/project'), '/project/other.jpg');
// Repeated filenames in separate directories remain separate; ambiguous short aliases add no phantom entry.
const collisions = [output('a', '/a/images/result.png'), output('b', '/b/images/result.png'), markdown('images/result.png')] as StreamMessage[];
assert.deepEqual(collectStudioImages(collisions, '/project').map(image => image.path), ['/a/images/result.png', '/b/images/result.png']);
// An alias in a new turn resolves to that turn's output, even when an older turn has the same filename.
const repeated = [output('old', '/old/images/result.png'), markdown('images/result.png'), {type:'user_prompt',prompt:'Again'}, output('new', '/new/images/result.png'), markdown('images/result.png')] as StreamMessage[];
assert.deepEqual(collectStudioImages(repeated, '/project').map(image => image.path), ['/old/images/result.png', '/new/images/result.png']);
// Prefer the exact project file when two distinct outputs share a basename.
assert.deepEqual(collectStudioImages([output('a', '/project/images/a.png'), output('b', '/other/images/a.png'), markdown('images/a.png')] as StreamMessage[], '/project').map(image => image.path), ['/project/images/a.png', '/other/images/a.png']);
console.log('image studio: provider path aliases and stale selections passed');
