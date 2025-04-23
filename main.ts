
/*
 * main.ts
 *
 * Initialises the plugin, adds command palette options, adds the settings UI
 * Markdown processing is done in renderer.ts and Pandoc invocation in pandoc.ts
 *
 */

import * as fs from 'fs';
import * as path from 'path';

import { Notice, Plugin, FileSystemAdapter, MarkdownView } from 'obsidian';
import { lookpath } from 'lookpath';
import { pandoc, inputExtensions, outputFormats, OutputFormat, needsLaTeX, needsPandoc } from './pandoc';
import * as YAML from 'yaml';
import * as temp from 'temp';

import render from './renderer';
import PandocPluginSettingTab from './settings';
import { PandocPluginSettings, DEFAULT_SETTINGS, replaceFileExtension } from './global';
export default class PandocPlugin extends Plugin {
    settings: PandocPluginSettings;
    features: { [key: string]: string | undefined } = {};

    async onload() {
        console.log('Loading Pandoc plugin');
        await this.loadSettings();

        // Check if Pandoc, LaTeX, etc. are installed and in the PATH
        this.createBinaryMap();

        // Register all of the command palette entries
        this.registerCommands();
        // transfrom the subject to settings tab
        this.addSettingTab(new PandocPluginSettingTab(this.app, this));
    }

    registerCommands() {
        for (let [prettyName, pandocFormat, extension, shortName] of outputFormats) {

            const name = 'Export as ' + prettyName;
            this.addCommand({
                id: 'pandoc-export-' + pandocFormat, name,
                checkCallback: (checking: boolean) => {
                    if (!this.app.workspace.activeLeaf) return false;
                    if (!this.currentFileCanBeExported(pandocFormat as OutputFormat)) return false;
                    if (!checking) {
                        this.startPandocExport(this.getCurrentFile(), pandocFormat as OutputFormat, extension, shortName);
                    }
                    return true;
                }
            });
        }
    }

    vaultBasePath(): string {
        return (this.app.vault.adapter as FileSystemAdapter).getBasePath();
    }

    getCurrentFile(): string | null {
        const fileData = this.app.workspace.getActiveFile();
        if (!fileData) return null;
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter)
            return adapter.getFullPath(fileData.path);
        return null;
    }

    currentFileCanBeExported(format: OutputFormat): boolean {
        // Is it an available output type?
        if (needsPandoc(format) && !this.features['pandoc']) return false;
        if (needsLaTeX(format) && !this.features['pdflatex']) return false;
        // Is it a supported input type?
        const file = this.getCurrentFile();
        if (!file) return false;
        for (const ext of inputExtensions) {
            if (file.endsWith(ext)) return true;
        }
        return false;
    }
    dealRelativePath(args: string[]): string[] {
      args = args.map(arg => {
          // Handle arguments with equals sign, like --lua-filter=template/pandoc/zotero.lua
          if (arg.includes('=')) {
              const [prefix, filePath] = arg.split('=', 2);
              // Check if the path part after the equals contains path separators
              if (filePath.includes('/') || filePath.includes('\\')) {
                  // Check if it's an absolute path
                  if (
                      filePath.startsWith('/') ||
                      filePath.startsWith('\\') ||
                      /^[A-Za-z]:/.test(filePath)
                  ) {
                      return arg; // Absolute path, leave unchanged
                  } else {
                      // Relative path, add vault base path
                      return `${prefix}=${path.join(this.vaultBasePath(), filePath)}`;
                  }
              }
              return arg; // Arguments without path separators remain unchanged
          }
          // Handle regular arguments
          else if (arg.includes('/') || arg.includes('\\')) {
              // Check if it's an absolute path or an option argument
              if (
                  arg.startsWith('/') ||
                  arg.startsWith('\\') ||
                  arg.startsWith('-') ||
                  /^[A-Za-z]:/.test(arg)
              ) {
                  return arg; // Absolute path or option argument, leave unchanged
              } else {
                  // Relative path, add vault base path
                  return path.join(this.vaultBasePath(), arg);
              }
          }
          return arg; // Other arguments remain unchanged
      });
      return args;
    }
    async createBinaryMap() {
        this.features['pandoc'] = this.settings.pandoc || await lookpath('pandoc');
        this.features['pdflatex'] = this.settings.pdflatex || await lookpath('pdflatex');
    }

    async startPandocExport(inputFile: string, format: OutputFormat, extension: string, shortName: string) {
        new Notice(`Exporting ${inputFile} to ${shortName}`);

        // Instead of using Pandoc to process the raw Markdown, we use Obsidian's
        // internal markdown renderer, and process the HTML it generates instead.
        // This allows us to more easily deal with Obsidian specific Markdown syntax.
        // However, we provide an option to use MD instead to use citations

        let outputFile: string = replaceFileExtension(inputFile, extension);
        if (this.settings.outputFolder) {
            outputFile = path.join(this.settings.outputFolder, path.basename(outputFile));
        }
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const args = this.dealRelativePath(this.settings.extraArguments.split('\n'));
        try {
            let error, command;

            switch (this.settings.exportFrom) {
                case 'html': {
                    const { html, metadata } = await render(this, view, inputFile, format);

                    if (format === 'html') {
                        // Write to HTML file
                        await fs.promises.writeFile(outputFile, html);
                        new Notice('Successfully exported via Pandoc to ' + outputFile);
                        return;
                    } else {
                        // Spawn Pandoc
                        const metadataFile = temp.path();
                        const metadataString = YAML.stringify(metadata);
                        await fs.promises.writeFile(metadataFile, metadataString);
                        const result = await pandoc(
                            {
                                file: 'STDIN', contents: html, format: 'html', metadataFile,
                                pandoc: this.settings.pandoc, pdflatex: this.settings.pdflatex,
                                directory: path.dirname(inputFile),
                            },
                            { file: outputFile, format },
                            args
                        );
                        error = result.error;
                        command = result.command;
                    }
                    break;
                }
                case 'md': {
                    const contentFile = temp.path();
                    let contents = fs.readFileSync(inputFile, 'utf8');
                    contents = contents.replace(/!\[\[(.*?)\/([^|\]]*?)(\|[^\]]*?)?\]\]/g, function(match, p1, p2, p3) {
                        p3 = p3 || '';  // if p3 is undefined, set it to an empty string
                        if (p3) {
                            // deal ![[folder/image.png|alt text]]
                            return `![${p3.substring(1)}](${p1}/${p2})`;
                        }
                        // deal ![[folder/image.png]]
                        return `![${p2}](${p1}/${p2})`;
                    });
                    contents = contents.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, function(match, p1, p2, p3) {
                        const displayText = p3 || p1;
                        return `[${displayText}](${p1})`;
                    });
                    fs.writeFileSync(contentFile, contents);
                    const result = await pandoc(
                        {
                            file: contentFile, format: 'markdown',
                            pandoc: this.settings.pandoc, pdflatex: this.settings.pdflatex,
                            directory: path.dirname(inputFile),
                        },
                        { file: outputFile, format },
                        args
                    );
                    error = result.error;
                    command = result.command;
                    break;
                }
            }

            if (error.length) {
                new Notice('Exported via Pandoc to ' + outputFile + ' with warnings');
                new Notice('Pandoc warnings:' + error, 10000);
            } else {
                new Notice('Successfully exported via Pandoc to ' + outputFile);
            }
            if (this.settings.showCLICommands) {
                new Notice('Pandoc command: ' + command, 10000);
                console.log(command);
            }

        } catch (e) {
            new Notice('Pandoc export failed: ' + e.toString(), 15000);
            console.error(e);
        }
    }

    onunload() {
        console.log('Unloading Pandoc plugin');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
