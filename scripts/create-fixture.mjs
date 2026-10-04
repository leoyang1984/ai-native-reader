import JSZip from 'jszip';
import { writeFile, mkdir } from 'node:fs/promises';
const zip = new JSZip();
zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">reader-lab-original-v1</dc:identifier><dc:title>分类与现实 · A Reader’s Fieldbook</dc:title><dc:creator>Reader Lab</dc:creator><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-10-02T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/><item id="c3" href="chapter3.xhtml" media-type="application/xhtml+xml"/><item id="image" href="map.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`);
zip.file('OEBPS/nav.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc" id="toc"><ol><li><a href="chapter1.xhtml">第一章 · 看见与分类</a></li><li><a href="chapter2.xhtml">Chapter 2 · Maps and Systems</a></li><li><a href="chapter3.xhtml">第三章 · 留给现实的余地</a></li></ol></nav></body></html>');
const zh = [
'每一种分类，都从一次温和的简化开始。世界以具体的样子来到我们面前：一条雨后积水的小路，一块夏天遮阴的空地，一种只有当地人熟悉的名字。系统需要可以传递的类别，而生活保留着难以归纳的细节。',
'分类减少的是系统需要处理的复杂度。它让一个机构能够比较不同的对象，让陌生人能够使用共同的词语交流。但被省略的部分并没有从现实中消失，它们只是暂时离开了表格。',
'一个好的抽象应该允许现实反向纠错。如果一次观察不符合分类，问题可能出在观察，也可能出在分类。能够保留这种可能性，才让模型成为学习的工具。',
'可读性让复杂的生活变成机构能够阅读的对象。土地变成面积，路线变成线条，名字变成编号。这样的翻译帮助我们行动，也会改变我们注意到什么。'
];
const en = [
'Every act of classification begins with a quiet simplification. A map omits almost everything so that a traveler can find a way. The important question is which details the map preserves and which people can revise it.',
'A system needs categories that travel. Local knowledge, meanwhile, survives in the timing of a harvest, the informal name of a place, and the exception that people nearby understand.',
'Legibility makes certain forms of action possible. Yet a useful abstraction remains open to correction. When the category becomes more authoritative than experience, a tool can quietly become a verdict.'
];
const chapter=(title,paragraphs,extra='')=>`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title><style>body{font-family:serif}p{line-height:1.8}</style></head><body><h2>${title}</h2>${paragraphs.map((p,i)=>`<p id="p${i}">${p}</p>`).join('')}${extra}</body></html>`;
zip.file('OEBPS/chapter1.xhtml', chapter('第一章 · 看见与分类', [...zh, ...Array.from({length:20},(_,i)=>`${zh[i%zh.length]} 这是第 ${i+1} 次对同一个问题的重新观察。`)], '<p>关于“可读性”的说明，见<a href="chapter2.xhtml#footnote" epub:type="noteref">注 1</a>。</p><img src="map.svg" alt="原始路径与分类网格的示意图"/>'));
zip.file('OEBPS/chapter2.xhtml',chapter('Chapter 2 · Maps and Systems',[...en,...Array.from({length:15},(_,i)=>`${en[i%en.length]} This is observation ${i+1}.`)],'<aside id="footnote" epub:type="footnote"><p>注 1：这里的可读性指复杂对象被转化成系统能够识别的表示方式。<a href="chapter1.xhtml#p3">返回原文</a></p></aside>'));
zip.file('OEBPS/chapter3.xhtml',chapter('第三章 · 留给现实的余地',[zh[2],zh[3],'今天的想法可以保留其来处：一段原文，一个阅读时刻，以及此刻留下的一句话。之后的理解会改变，但这些线索能够帮助我们回到思考发生的地方。']));
zip.file('OEBPS/map.svg','<svg xmlns="http://www.w3.org/2000/svg" width="600" height="180" viewBox="0 0 600 180"><rect width="600" height="180" fill="#eceade"/><path d="M20 140 Q120 5 220 100 T400 70 T570 40" fill="none" stroke="#77866b" stroke-width="3"/><path d="M0 60H600 M0 120H600 M100 0V180 M200 0V180 M300 0V180 M400 0V180 M500 0V180" stroke="#bab6a8" stroke-width="1"/></svg>');
for (const file of Object.values(zip.files)) file.date = new Date('2026-10-02T00:00:00Z');
await mkdir('public/samples',{recursive:true});
await writeFile('public/samples/reader-lab.epub',await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}}));
console.log('Created original bilingual EPUB fixture: public/samples/reader-lab.epub');
