const axios = require('axios');
const asciidoctor = require('asciidoctor')();
const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');

const OUTPUT_FILE = 'mastering-bitcoin.pdf';
const TEMP_DIR = './temp_adoc_files';
const API_URL = `https://api.github.com/repos/bitcoinbook/bitcoinbook/contents`;


async function fetchRepoContents(folder = '') {
    try {
        const response = await axios.get(API_URL + '/' + folder);
        return response.data;
    } catch (error) {
        console.error('Error fetching repository contents:', error);
        throw error;
    }
}

async function downloadFile(fileUrl, responseType = 'utf8') {
    try {
        const response = await axios.get(fileUrl, { responseType, family: 4, timeout: 10000 });
        return responseType === 'arraybuffer' ? response.data : response.data.toString('utf8');
    } catch (error) {
        console.error('Error downloading file:', error);
        throw error;
    }
}

async function getChapterFiles() {
    const repoContents = await fetchRepoContents();
    return repoContents
        .filter(file => file.name.startsWith('ch') && file.name.endsWith('.adoc'))
        .map(file => ({
            name: file.name,
            downloadUrl: file.download_url
        }));
}

async function getCodeFiles() {
    const codeContents = await fetchRepoContents('code');
    return codeContents.map(file => ({
        name: file.name,
        downloadUrl: file.download_url
    }));
}

async function createCodeFiles(files) {
    const downloadPromises = files.map(file => downloadFile(file.downloadUrl));
    const contents = await Promise.all(downloadPromises);

    await fs.ensureDir(path.join(TEMP_DIR, 'code'));

    const savePromises = files.map((file, index) => {
        const filePath = path.join(TEMP_DIR, 'code', file.name);
        return fs.outputFile(filePath, contents[index], 'utf8');
    });

    await Promise.all(savePromises);
}

async function getImageFiles() {
    const imageContents = await fetchRepoContents('images');
    return imageContents.map(file => ({
        name: file.name,
        downloadUrl: file.download_url
    }));
}


async function createImageFiles(files) {
    const downloadPromises = files.map(file => downloadFile(file.downloadUrl, 'arraybuffer'));
    const contents = await Promise.all(downloadPromises);

    const imagesDir = path.join(TEMP_DIR, 'images');
    await fs.ensureDir(imagesDir);

    const savePromises = files.map((file, index) => {
        const filePath = path.join(imagesDir, file.name);
        return fs.writeFile(filePath, contents[index]);
    });

    await Promise.all(savePromises);
    console.log(`Images saved to ${imagesDir}`);
}


async function mergeFiles(files) {
    const downloadPromises = files.map(file => downloadFile(file.downloadUrl));
    let contents = await Promise.all(downloadPromises);


    contents = contents.map(content => {
        return content.replace(/image::(.*?)\[(.*?)\]/g, (match, imagePath, alt) => {

            const cleanImagePath = imagePath.replace(/^images\//, '');
            return `image::${cleanImagePath}[${alt}]`;
        });
    });

    return contents.join('\n\n');
}

async function saveAsPDF(mergedContent) {
    const tempAdocPath = path.join(TEMP_DIR, 'merged.adoc');
    await fs.outputFile(tempAdocPath, mergedContent, 'utf8');

    const imagesDir = path.resolve(TEMP_DIR, 'images');
    console.log('Images directory:', imagesDir);

    const options = {
        safe: 'safe',
        to_file: false,
        base_dir: TEMP_DIR,
        attributes: {
            'imagesdir': imagesDir,
            'data-uri': true,
            'stem': 'latexmath',
            'mathematical-format': 'svg',
            'mathematical-inline': 'svg',
            'source-highlighter': 'highlight.js',
            'icons': 'font',
            'sectlinks': true,
            'experimental': true,
            'listing-caption': 'Listing'
        }
    };

    console.log('Converting AsciiDoc to HTML...');
    const html = asciidoctor.convertFile(tempAdocPath, options);

    const htmlWithMathJax = `
        <!DOCTYPE html>
        <html>
        <head>
            <script>
                window.MathJax = {
                    tex: {
                        inlineMath: [['\\\\(', '\\\\)']],
                        displayMath: [['\\\\[', '\\\\]']],
                        processEscapes: true
                    },
                    svg: {
                        fontCache: 'global'
                    }
                };
            </script>
            <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-svg.js"></script>
            <style>
                img { max-width: 100%; height: auto; }
                .imageblock { text-align: center; margin: 1em 0; }
                .imageblock img { margin: 0 auto; display: block; }
                .imageblock .title { margin-top: 0.5em; font-style: italic; }
            </style>
        </head>
        <body>
            ${html}
        </body>
        </html>
    `;

    console.log('Launching Puppeteer...');
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    page.on('console', msg => console.log('Page log:', msg.text()));
    page.on('error', err => console.error('Page error:', err));
    page.on('pageerror', err => console.error('Page error:', err));

    await page.setViewport({ width: 1200, height: 800 });
    await page.setJavaScriptEnabled(true);

    console.log('Setting page content...');
    await page.setContent(htmlWithMathJax);

    console.log('Waiting for MathJax...');
    await page.waitForFunction('typeof MathJax !== "undefined" && MathJax.typesetPromise !== undefined')
        .catch(err => console.error('MathJax loading error:', err));
    await page.evaluate(() => MathJax.typesetPromise())
        .catch(err => console.error('MathJax typesetting error:', err));

    console.log('Waiting for images to load...');
    await page.evaluate(() => {
        return new Promise((resolve) => {
            const images = Array.from(document.images);
            const pendingImages = images.filter(img => !img.complete);

            if (pendingImages.length === 0) {
                console.log('All images already loaded');
                resolve();
                return;
            }

            let loadedImages = 0;
            const imageLoaded = () => {
                loadedImages++;
                console.log(`Image loaded: ${loadedImages}/${pendingImages.length}`);
                if (loadedImages === pendingImages.length) {
                    console.log('All images loaded');
                    resolve();
                }
            };

            pendingImages.forEach(img => {
                img.addEventListener('load', imageLoaded);
                img.addEventListener('error', () => {
                    console.error(`Failed to load image: ${img.src}`);
                    imageLoaded();
                });
            });
        });
    });

    console.log('Generating PDF...');
    await page.pdf({
        path: OUTPUT_FILE,
        format: 'A4',
        printBackground: true,
        margin: {
            top: '20mm',
            right: '20mm',
            bottom: '20mm',
            left: '20mm'
        },
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: '<div style="font-size: 10px; text-align: center; width: 100%;"><span class="pageNumber"></span></div>'
    });

    await Promise.all([
        browser.close(),
        fs.remove(TEMP_DIR)
    ]);
    console.log(`PDF saved as ${OUTPUT_FILE}`);
}

async function main() {
    try {
        console.log('Creating temporary directory...');
        await fs.ensureDir(TEMP_DIR);

        console.log('Processing code files...');
        console.log('Processing image files...');
        console.log('Processing chapter files...');

        const [_, __, chapterFiles] = await Promise.all([
            createCodeFiles(await getCodeFiles()),
            createImageFiles(await getImageFiles()),
            getChapterFiles()
        ]);

        const mergedContent = await mergeFiles(chapterFiles);

        console.log('Generating PDF...');
        await saveAsPDF(mergedContent);

        console.log('Process completed successfully!');
    } catch (error) {
        console.error('Error:', error);
    }
}

main();