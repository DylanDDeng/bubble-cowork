import assert from 'node:assert/strict';
import {
  extractMediaPathsFromValue,
  isMediaGenerationTool,
  withGeneratedMediaInput,
} from '../../src/shared/generated-media';
import {
  excludeMediaShownInMarkdown,
  extractGeneratedMediaFromMessages,
  extractMarkdownImageSources,
  normalizeBacktickMarkdownImages,
  stripGeneratedMediaEmbeds,
} from '../../src/ui/utils/generated-media';
import type { StreamMessage } from '../../src/ui/types';

function testPathExtraction() {
  const fromText = extractMediaPathsFromValue(
    'Saved to /tmp/grok/assets/image-abc.jpg and mentioned images/1.png',
    'image'
  );
  assert.deepEqual(
    fromText.map((item) => item.path),
    ['/tmp/grok/assets/image-abc.jpg', 'images/1.png']
  );

  const fromObject = extractMediaPathsFromValue({
    path: '/Users/me/.grok/sessions/x/assets/shot.mp4',
  });
  assert.equal(fromObject[0]?.kind, 'video');
  assert.equal(fromObject[0]?.path, '/Users/me/.grok/sessions/x/assets/shot.mp4');

  const fromUri = extractMediaPathsFromValue({
    uri: 'file:///Users/me/project/images/cover.webp',
  });
  assert.equal(fromUri[0]?.path, '/Users/me/project/images/cover.webp');
}

function testToolNameRecognition() {
  assert.equal(isMediaGenerationTool('image_gen'), true);
  assert.equal(isMediaGenerationTool('image_to_video'), true);
  assert.equal(isMediaGenerationTool('Imagine'), true);
  assert.equal(isMediaGenerationTool('grep'), false);
}

function testMessageExtraction() {
  const messages = [
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'image_gen',
            input: withGeneratedMediaInput(
              { prompt: 'a golden sunset' },
              [{ path: '/tmp/sunset.jpg', kind: 'image' }]
            ),
          },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: 'Wrote /tmp/sunset.jpg',
          },
        ],
      },
    },
  ] as StreamMessage[];

  const media = extractGeneratedMediaFromMessages(messages);
  assert.equal(media.length, 1);
  assert.equal(media[0]?.path, '/tmp/sunset.jpg');
  assert.equal(media[0]?.kind, 'image');
  assert.equal(media[0]?.prompt, 'a golden sunset');
}

function testResultFallback() {
  const messages = [
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'call-2',
            name: 'image_to_video',
            input: { prompt: 'cat playing piano' },
          },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-2',
            content: 'Video saved to /tmp/assets/cat.mp4',
          },
        ],
      },
    },
  ] as StreamMessage[];

  const media = extractGeneratedMediaFromMessages(messages);
  assert.equal(media[0]?.path, '/tmp/assets/cat.mp4');
  assert.equal(media[0]?.kind, 'video');
}

function testDuplicatePathCollapse() {
  const messages = [
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'call-3',
            name: 'image_gen',
            input: withGeneratedMediaInput(
              { prompt: 'a tree' },
              [{ path: '/tmp/.grok/sessions/x/images/1.jpg', kind: 'image' }]
            ),
          },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-3',
            content: 'Saved images/1.jpg',
          },
        ],
      },
    },
  ] as StreamMessage[];

  const media = extractGeneratedMediaFromMessages(messages);
  assert.equal(media.length, 1);
  assert.equal(media[0]?.path, '/tmp/.grok/sessions/x/images/1.jpg');
}

function testBacktickImageNormalizeAndStrip() {
  assert.equal(
    normalizeBacktickMarkdownImages('已生成一棵树：\n\n![一棵树](`images/1.jpg`)\n\n一棵独立的老橡树'),
    '已生成一棵树：\n\n![一棵树](images/1.jpg)\n\n一棵独立的老橡树'
  );
  assert.equal(
    stripGeneratedMediaEmbeds(
      '已生成一棵树：\n\n![一棵树](`images/1.jpg`)\n\n一棵独立的老橡树',
      [{ path: '/tmp/.grok/sessions/x/images/1.jpg', kind: 'image' }]
    ),
    '已生成一棵树：\n\n一棵独立的老橡树'
  );
}

function testMarkdownImageDedup() {
  assert.deepEqual(
    extractMarkdownImageSources('一只猫\n\n![一只橘色虎斑猫](images/1.jpg)\n\n想换成别的'),
    ['images/1.jpg']
  );

  const hidden = excludeMediaShownInMarkdown(
    [{ path: '/tmp/project/images/1.jpg', kind: 'image' }],
    ['images/1.jpg']
  );
  assert.deepEqual(hidden, []);

  const kept = excludeMediaShownInMarkdown(
    [{ path: '/tmp/project/images/2.jpg', kind: 'image' }],
    ['images/1.jpg']
  );
  assert.equal(kept.length, 1);
}

testPathExtraction();
testToolNameRecognition();
testMessageExtraction();
testResultFallback();
testDuplicatePathCollapse();
testBacktickImageNormalizeAndStrip();
testMarkdownImageDedup();
console.log('generated-media tests passed');
