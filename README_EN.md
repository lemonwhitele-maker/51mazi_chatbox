# 🚀 The Best Novel Writing Software You'll Ever Use

[English](README_EN.md) | [中文](README.md)

> 💡 As a novel creator, have you ever been frustrated by the lack of suitable writing tools? Today, I'd like to introduce **51mazi**, a powerful and beautifully designed desktop novel writing software. Built with modern technology, this software provides comprehensive support for novel creators, from outline planning to content creation.
>
> 💡 **If this project helps you, please give it a Star!**

## 📋 Table of Contents

- [Software Overview](#software-overview)
- [Core Features](#core-features)
  - [Multi-Book Management System](#multi-book-management-system)
  - [AI Cover Generation](#ai-cover-generation)
  - [Avatars and Character Images](#avatars-and-retained-image-support)
  - [API Settings and Library Transfers](#api-settings-and-library-transfers)
  - [AI Scene Image](#ai-scene-image)
  - [Professional Writing Experience](#professional-writing-experience)
  - [Map Design Tool](#map-design-tool)
  - [Relationship Graph Management](#relationship-graph-management)
  - [Dictionary Management](#dictionary-management)
  - [Random Name Generator](#random-name-generator)
  - [Character, Setting, and Outline Documents](#knowledge-documents)
  - [Timeline Management](#timeline-management)
  - [Event Sequence Diagram Management](#event-sequence-diagram-management)
  - [Organization Structure Management](#organization-structure-management)
  - [Download Novels](#download-novels)
  - [User Guide](#user-guide)
- [Technical Architecture Highlights](#technical-architecture-highlights)
- [Software Advantages](#software-advantages)
- [Feature Comparison](#feature-comparison)
- [Target Audience](#target-audience)
- [Usage Recommendations](#usage-recommendations)
- [Future Outlook](#future-outlook)
- [Development Environment Setup](#development-environment-setup)
- [Summary](#summary)
- [Contact & Support](#contact--support)
- [Tags](#tags)

---

<span id="software-overview"></span>
## 🎯 Software Overview

**51mazi** is a desktop novel writing software developed with Electron + Vue 3 technology stack, specifically designed for novel creators. It not only provides a professional writing environment but also integrates creative assistance tools such as map design, relationship graphs, Markdown knowledge documents, AI-assisted creation, and novel download, making novel writing more efficient and enjoyable.

*Software Homepage Interface - Clean and Beautiful Bookshelf Management Interface*

<span id="core-features"></span>
## ✨ Core Features

<span id="multi-book-management-system"></span>
### 📚 Multi-Book Management System

The software uses a bookshelf-style management system, supporting the creation, editing, and deletion of multiple books. Each book has an independent data directory structure, ensuring data security and independence.

- **Bookshelf Password Protection**: Support for setting password protection for the entire bookshelf, requiring password verification on startup to ensure creative content security
  - Support for setting, modifying, and canceling bookshelf passwords
  - Password hint functionality to help remember passwords
  - 8-16 character alphanumeric combination, secure and reliable
- **Book Password Protection**: Support for setting password protection for individual books (optional, 4-8 character alphanumeric)
- **Smart Naming**: Automatically creates default chapters, supports book name length restrictions
- **Data Isolation**: Each book is stored independently without interference
- **Cover Management**: Choose a local cover image or customize cover color
- **AI Cover Generation**: Integrated Tongyi Wanxiang to generate novel covers from title/pen name/prompt, then apply in one click

<span id="ai-cover-generation"></span>
#### 🤖 AI Cover Generation

In the **Create/Edit Book** drawer, click **AI Cover Generation** to generate multiple candidate covers based on the title and pen name. Pick one, click **Confirm Use**, then save the book — the cover will appear on the bookshelf.

<span id="avatars-and-retained-image-support"></span>
### 🎨 Avatars and Character Images

Generate a **720×1280 portrait** in the current **character document** workspace. Preview a candidate and click **Use image and save character** to save one avatar together with the current character text. Character lists show thumbnails. If a version conflict or save error occurs, the editor contents and candidate images remain available for retry.

Confirmed images are saved in the book's `character_images` folder and referenced by paths relative to that book, so copying the complete book or library keeps them available. Cancelling generation clears only the current session's temporary images; previously saved images are not deleted automatically. Linked character nodes in the **relationship graph** can refresh their avatars, while manually chosen node images remain independent.

Each character has one avatar. The old character profile form and gallery remain retired, and old character documents are not migrated automatically.

<span id="api-settings-and-library-transfers"></span>
### 🔑 API Settings and Library Transfers

API settings remain shared across the application. Select a library folder, such as `BookList`, before saving AI settings. Chat models, the function API, DeepSeek, Tongyi Wanxiang, Gemini, Doubao, and the last selected image provider are stored together in **`BookList/.51mazi/api-config.json`**.

The first migration backs up only the old API settings inside the library's `.51mazi` folder. The original application's API entries are removed only after the new file is written and verified. Existing destination values take precedence, with missing settings filled from the old configuration. Failures preserve the original settings. Ordinary preferences, such as theme and window state, remain in application storage.

To move to another computer, copy the **complete BookList, including `.51mazi`**, then select that library in the app to load books, saved character images, and in-app API settings. Switching to a library with an existing configuration uses that configuration; an unconfigured destination receives the current shared settings. External Codex installation, login, and configuration, and unsaved editing drafts, must be handled separately.

Novel text exports do not include API settings. When sharing an entire library directly, exclude its API configuration and migration backups from `.51mazi`.

<span id="ai-scene-image"></span>
### 🖼️ AI Scene Image

On the **chapter editor** page, select a passage of body text, then click **AI Scene Image** in the **top-right** of the editing area (below **AI Continuation**). The selection must be within roughly **100–1000 effective characters** (same word-count rules as the rest of the app, whitespace excluded). After validation, a **right-side drawer** opens where you can configure:

- **Output size**: Landscape **1280×720** (default) or square **1280×1280**
- **Art style / shot / environment / lighting**: Choose an art style and scene composition options
- **Scene description**: Prefilled from the selection; you can refine it into a more **visual** prompt (up to 500 characters)
- **Refine scene with DeepSeek (optional)**: Compresses the full selection into a shorter image prompt; requires a DeepSeek API key
- **Negative prompt (optional)**: Reduces blur, deformities, watermarks, etc.

Images are generated by **Tongyi Wanxiang** and saved **directly** under the book folder **`scene_images`** as `scene_<timestamp>.png`. The drawer shows a **large preview** and the **full local path** with **copy** support; you can click **Generate another** multiple times in the same session. A **Tongyi Wanxiang API key is required** (same **AI Settings** entry as cover and character images).

<span id="professional-writing-experience"></span>
### ✍️ Professional Writing Experience

*Professional Writing Editor Interface - Rich Text Editor Based on TipTap*

- **Rich Text Editing**: Professional editor based on TipTap, supporting formatted text, headings, paragraphs, etc.
- **Personalized Settings**: Support for font, font size, line height settings, bold, italic formatting, and auto-save configuration
- **Real-time Statistics**: Real-time display of chapter word count, total book word count, and writing speed (words per minute/hour)
- **Smart Features**: Auto-save, full-text search, one-click export of all chapters
- **Keyboard Shortcuts**: Ctrl/Cmd + S for quick save, Ctrl/Cmd + F for search
- **Multiple Themes**: Light, dark, eye-protection yellow, and other theme modes
- **AI Polishing**: Polish selected text or the whole chapter to improve clarity and readability while preserving the original meaning and style
- **AI Continuation**: Optionally provide continuation requirements; preview the generated continuation, then copy it or confirm to insert at the end of the chapter
  - When the chapter word count reaches the target, the app will prompt you to create a new chapter
  - Continuation length is calculated using a 120% cap of the chapter target (cap total words − current chapter words)
  - If the current chapter is empty, the app will prefer continuing from the end of the previous chapter; if there is no previous chapter, you must write at least 200 words before using continuation
- **AI Scene Image**: Select a passage (~100–1000 effective characters), configure style and description in the drawer, then generate a scene illustration via Tongyi Wanxiang; files are saved under the book’s `scene_images` folder, with optional DeepSeek refinement (see [AI Scene Image](#ai-scene-image) above)
- **Character Highlighting**: Support for highlighting character names in the editor, making it easy to track character appearances
- **Forbidden Word Detection**: Intelligent detection and marking of forbidden words, supports custom forbidden word lists with real-time underline prompts
- **Paragraph Dragging**: Support for dragging to adjust paragraph order, flexibly organizing content structure
- **Text Highlighting**: Support for text highlighting to mark important content

<span id="map-design-tool"></span>
### 🗺️ Map Design Tool

*Powerful Map Design Tool - Professional Canvas Drawing and Resource Management*

The map design tool is a major highlight of this software, providing professional-level map drawing capabilities:

#### Core Drawing Tools
- **Brush Tool (P)**: Freehand drawing with customizable size and opacity, smooth drawing experience
- **Eraser Tool (E)**: Precise erasing with adjustable erasing range
- **Shape Tool (G)**: Supports lines, rectangles, circles, rounded rectangles, five-pointed stars, arrows, and other shapes
- **Paint Bucket Tool**: Quick area filling with custom colors and intelligent boundary detection
- **Text Tool (T)**: Add text annotations with customizable font, size, and color
- **Resource Tool**: Built-in rich resource icon library, supports drag-and-drop to add buildings, landmarks, and other map elements
- **Background Tool**: Set canvas background color to create personalized map styles

#### Advanced Features
- **Selection Tool (V)**: Select, move, resize, and rotate drawn elements
- **Move Tool (H)**: Pan canvas view, supports spacebar for quick switching
- **Zoom Control**: Supports canvas zoom (Ctrl/Cmd + scroll wheel), pan, and reset view
- **Undo/Redo**: Complete history management with multi-step undo and redo
- **Real-time Preview**: Real-time preview during drawing
- **Parameter Adjustment**: Size and opacity sliders for precise control of drawing effects
- **Color Selection**: Rich color presets with support for custom colors
- **Save & Export**: Automatically generates map preview images, supports saving as PNG format

<span id="relationship-graph-management"></span>
### 👥 Relationship Graph Management

*Visual Relationship Graph - Clearly Displaying Character Relationship Networks*

The relationship graph feature helps authors better manage complex character relationships:
- **Visual Component**: Visualization based on relation-graph-vue3
- **Node Management**: Add, delete, modify, and query character nodes with support for custom node styles
- **Avatar Support**: Support for setting avatars for character nodes (local images or network images)
- **Dynamic Fonts**: Automatically adjusts font size based on node hierarchy
- **Connection Editing**: Edit relationship connection types and descriptions
- **Thumbnail Generation**: Automatically generates relationship graph previews
- **Data Persistence**: Local file storage ensures data security

<span id="dictionary-management"></span>
### 📖 Dictionary Management

The dictionary feature provides powerful vocabulary management capabilities for novel creation:
- **Tree Structure**: Supports multi-level dictionary classification, clearly organizing vocabulary systems
- **Entry Management**: Supports creating, editing, and deleting entries with information such as names and descriptions
- **Drag-and-Drop Sorting**: Supports dragging to adjust entry order and hierarchy
- **Quick Search**: Supports keyword search to quickly locate target entries
- **Data Persistence**: Local file storage ensures data security

<span id="random-name-generator"></span>
### 🎲 Random Name Generator

*Intelligent Random Name Generator - Providing Inspiration for Character Naming*

The random name generator provides powerful naming assistance for novel creation:

#### Core Features
- **Multiple Type Support**: Supports Chinese names, Japanese names, Western names, faction names, place names, secret technique names, magical artifact names, elixir names, and other types
- **Parameter Customization**: Supports setting surname, gender, name length, middle characters, and other parameters for precise control of generation results
- **Batch Generation**: Can generate 24 names at once, providing rich choices
- **AI Intelligent Naming**: Integrated DeepSeek AI to intelligently generate names that match cultural background and character settings
  - **Intelligent Understanding**: AI generates names that meet requirements based on type, gender, surname, and other parameters
  - **Cultural Adaptation**: Japanese and Western names are automatically converted to Chinese transliteration, ensuring all names are pure Chinese
  - **Creativity and Reasonableness**: Generated names are both creative and conform to cultural background and naming conventions
  - **Intelligent Fallback**: Automatically falls back to local generation when AI fails, ensuring functionality availability
- **Local Generation**: Retains traditional local word bank generation method, usable without network
- **Seamless Switching**: Free switching between AI generation and local generation
- **Rate Limiting**: Intelligently controls API call frequency to avoid excessive use

<span id="knowledge-documents"></span>
### 👤 Character, Setting, and Outline Documents

Characters, settings, and outlines now use independent **Markdown knowledge documents**. Authors can adapt the content and sections to their work while retaining stable identifiers, tags, and document references.

- **Document editing**: Create, find, and edit documents in each workspace, then save them in the current book directory.
- **References**: Inspect linked documents and backlinks; organize outlines with tags, ordering, and chapter links.
- **Assistant collaboration**: The assistant can read documents and propose changes for the author to confirm before writing.
- **Outline navigation**: Open the outline workspace from the book toolbar. The compact outline tree and old outline AI draft workbench have been removed.
- **Avatars**: Character documents support generating and saving one portrait, list thumbnails, and avatar updates for linked relationship graph nodes. The old profile form and image gallery remain retired.

This cleanup removes feature code without deleting files in user book directories. Automatic migration of old character JSON/HTML, categorized setting JSON, outline trees, and outline AI drafts to the new documents is not supported. Existing files remain in place and do not automatically appear in the new workspace.

<span id="timeline-management"></span>
### 📅 Timeline Management

*Timeline Management Tool - Organizing Story Development Threads*

<span id="event-sequence-diagram-management"></span>
### 📊 Event Sequence Diagram Management

*Visual Event Sequence Diagram Management - Intuitively Displaying Event Timeline and Progress*

The event sequence diagram feature provides powerful timeline management capabilities for novel creation:
- **Timeline Visualization**: Visual event display based on time cells
- **Event Management**: Supports creating, editing, and deleting events with information such as introduction, details, and progress
- **Drag-and-Drop Adjustment**: Intuitive drag-and-drop operations to adjust event time positions, intelligently distinguishing between click and drag operations
- **Progress Tracking**: Event progress bar display, supports 0-100% progress management with visual progress bar effects
- **Multiple Sequence Diagrams**: Supports creating multiple independent sequence diagrams to meet different chapter or storyline needs
- **Panel Control**: Supports collapsing/expanding the left panel to optimize interface layout
- **Color Management**: Rich color selection with support for custom event colors
- **Hover Tooltips**: Mouse hover displays complete event details
- **Data Persistence**: Local file storage ensures data security

<span id="organization-structure-management"></span>
### 🏢 Organization Structure Management

*Visual Organization Structure Management - Clearly Displaying Organizational Structure and Hierarchy*

The organization structure feature provides powerful organizational management capabilities for novel creation:
- **Hierarchical Structure**: Supports multi-level organizational structures, clearly displaying superior-subordinate relationships
- **Node Management**: Supports creating, editing, and deleting organizational nodes with information such as names and descriptions
- **Visual Display**: Visualization component based on relationship graphs, intuitively displaying organizational structure
- **Color Differentiation**: Different levels use different colors for easy distinction and understanding
- **Drag-and-Drop Adjustment**: Supports drag-and-drop operations to adjust organizational structure layout
- **Multiple Organization Management**: Supports creating multiple independent organizational structures to meet different story needs
- **Data Persistence**: Local file storage ensures data security

<span id="download-novels"></span>
### 📥 Download Novels

*Download Novels page - Multi-source search; after selecting a book, the floating bottom action area supports adding to bookshelf or exporting as TXT*

The novel download feature lets you search by title or author, choose a source, and download novels from the web to local storage—either adding them to the bookshelf or exporting as TXT (for personal study and research only; please comply with local laws and regulations).

- **Multi-source Support**: Multiple built-in sources; switch sources to search
- **Search & Select**: Enter title or author keyword, view search results, click "Download" to fetch the chapter list
- **Download and Add to Bookshelf**: One-click download of all chapters to the local book directory and add to the current bookshelf
- **Export as TXT**: Export the full book as a single TXT file to a folder of your choice
- **Floating Bottom Action Bar**: After selecting a book, the action area stays fixed at the bottom of the page so you can see progress while scrolling the list
- **Ad Removal in Content**: Automatically filters common in-page promotions and ad copy for cleaner export
- **Disclaimer**: A clear disclaimer on the page reminds users to use the feature in compliance with applicable laws

<span id="user-guide"></span>
### 📘 User Guide

Built-in complete user guide functionality to help users get started quickly:
- **Feature Descriptions**: Detailed feature introductions and usage instructions
- **Operation Guides**: Clear operation steps and tips
- **FAQ**: Answers to common user questions
- **Quick Start**: Beginner-friendly tutorial

<span id="technical-architecture-highlights"></span>
## 🛠️ Technical Architecture Highlights

### Modern Technology Stack

- **Electron 39.2.7**: Cross-platform desktop application framework
- **Vue 3.5.22**: Progressive JavaScript framework
- **Vite 6.4.0**: Modern build tool
- **Element Plus 2.11.4**: Enterprise-level UI component library

### Core Function Libraries

- **TipTap 3.7.0**: Rich text editor based on ProseMirror
- **ECharts 6.0.0**: Data visualization chart library
- **relation-graph-vue3 2.2.11**: Relationship graph visualization component
- **Pinia 3.0.3**: Official state management library recommended for Vue 3

<span id="software-advantages"></span>
## 🚀 Software Advantages

### 1. Complete Local Storage
All data is stored locally, protecting user privacy without worrying about data leaks.

### 2. Cross-Platform Support
Based on the Electron framework, supports Windows, macOS, Linux, and other platforms.

### 3. Professional Writing Experience
- Professional rich text editor based on TipTap
- Real-time word count statistics and writing speed calculation
- Intelligent auto-save mechanism
- Multiple theme modes to meet different needs

### 4. Creative Assistance Tools
- **Professional Map Design Tool**: Canvas drawing engine with support for brush, shapes, text, paint bucket, resource tools, and more. Built-in resource icon library, drag-and-drop to add buildings and landmarks, complete history and undo/redo functionality
- **Intelligent Editor Features**: Character highlighting, forbidden word detection, paragraph dragging, text highlighting, and other practical features
- **AI-Assisted Creation**: Integrated DeepSeek + Tongyi Wanxiang
  - **AI Random Naming (DeepSeek)**: Multiple name types and parameters, with automatic fallback to local generation when AI fails
  - **AI Polishing / AI Continuation (DeepSeek)**: Polish the selection or the whole chapter; continuation supports optional instructions, respects the 120% target-word cap, and can be inserted at chapter end
  - **AI Novel Cover (Tongyi Wanxiang)**: Generate multiple covers by title/pen name/size/prompt and set one as the book cover
  - **AI Scene Image (Tongyi Wanxiang + optional DeepSeek)**: Generate scene illustrations from selected chapter text; saved to `scene_images`; optional DeepSeek step to turn prose into an image prompt
- **Download novels**: Multi-source search, add to bookshelf or export as TXT, with floating bottom action bar and progress display
- Relationship graph management for complex character relationships with avatar and dynamic font support
- Event sequence diagram management for event timelines and progress with visual progress tracking
- Organization structure management to display organizational structure and hierarchy
- Dictionary management for vocabulary systems with tree structure and drag-and-drop sorting support
- Random name generator providing creative inspiration (supports both AI and local modes)
- Markdown character, setting, and outline documents with references and assistant change proposals
- Intelligent book management with bookshelf password protection and book password protection

### 5. User-Friendly Interface
- Clean and beautiful interface design
- Responsive layout adapting to different screens
- Intuitive operation flow
- Complete error handling mechanism
- **Writing Encouragement Toasts**: Start after 2 days, then show randomly (once per day, auto-close in 5s or manual close)
- **Version Display**: Shows current app version at the bottom of the left sidebar for easier issue reporting

<span id="feature-comparison"></span>
## 📊 Feature Comparison

| Feature | 51mazi | Other Writing Software |
|---------|--------|----------------------|
| Local Storage | ✅ Completely Localized | ❌ Partially Cloud Storage |
| Password Protection | ✅ Bookshelf Password + Book Password Dual Protection | ❌ Lack of Security Protection |
| Map Design | ✅ Professional Canvas Drawing, Resource Management, Multiple Tools | ❌ Requires External Tools |
| Editor Features | ✅ Character Highlighting, Forbidden Word Detection, Paragraph Dragging | ❌ Basic Editing Features |
| Relationship Graph | ✅ Visual Management with Avatar Support | ❌ Manual Recording |
| Event Sequence Management | ✅ Timeline Visualization, Progress Tracking | ❌ Lack of Time Management |
| Organization Structure | ✅ Visual Organization Management | ❌ Lack of Organization Management |
| Dictionary | ✅ Tree Structure, Drag-and-Drop Sorting | ❌ Lack of Vocabulary Management |
| AI Assistance | ✅ DeepSeek naming/polish/continuation + Tongyi Wanxiang cover/scene image | ❌ Lack of AI Features |
| Smart Operations | ✅ Intelligent Drag-and-Drop, Keyboard Shortcut Support | ❌ Cumbersome Operations |
| Multiple Themes | ✅ Multiple Themes | ❌ Single Theme |
| User Guide | ✅ Built-in Complete Guide | ❌ Requires External Documentation |
| Download Novels | ✅ Multi-source search, add to bookshelf / export TXT | ❌ Manual copy or external tools |
| Cross-Platform | ✅ Full Platform Support | ❌ Platform Limitations |
| Free to Use | ✅ Completely Free | ❌ Paid Subscription |

<span id="target-audience"></span>
## 🎯 Target Audience

- **Web Novel Authors**: Need to manage complex plots and character relationships
- **Traditional Literary Creators**: Need a professional writing environment
- **Script Writers**: Need timeline and character management
- **Game Story Planners**: Need map design and world-building

<span id="usage-recommendations"></span>
## 💡 Usage Recommendations

### Getting Started
1. First, set the book main directory
2. (Optional) Set bookshelf password to protect all book data
3. Create your first book (supports password protection)
4. Familiarize yourself with basic editor functions (shortcut Ctrl/Cmd + S to save)
5. Try advanced editor features
   - Enable character highlighting to track character appearances
   - Set forbidden word list to avoid sensitive vocabulary
   - Use paragraph dragging to flexibly organize content
6. (Optional) Open **AI Settings** from the left menu, configure DeepSeek / Tongyi Wanxiang API keys, and click “Validate”
7. (Optional) Use **AI Cover Generation** in the book create/edit drawer: fill in title & type, generate covers and confirm one
8. Open the character workspace and create Markdown documents for character backgrounds, current state, and confirmed facts
9. (Optional) On the chapter editor, select a passage (~100–1000 effective characters), click **AI Scene Image**, adjust style and description in the drawer, then generate (Tongyi Wanxiang key required; optional DeepSeek refinement)
10. Try the map design tool
   - Use brush tool to draw terrain outlines
   - Use paint bucket to fill area colors
   - Drag resource icons to add buildings and landmarks
11. Build character relationship graph (can set avatars)
12. Create dictionary to manage proper nouns in the story
13. Experience AI random naming feature
   - Configure DeepSeek API Key in settings (optional)
   - Use AI intelligent naming to generate character names
   - Try different parameter settings to experience AI's intelligent understanding capabilities
14. Add setting and outline documents, using references to connect characters, settings, and chapters
15. (Optional) Use Download Novels: from the left menu open "Download Novels", choose a source, enter title or author to search, then "Download and Add to Bookshelf" or "Export as TXT"; the action bar floats at the bottom so you can see progress while scrolling

### Advanced Usage
1. Use timeline to manage story development
2. Use event sequence diagram to plan event timeline and progress (supports drag-and-drop adjustment)
3. Use organization structure management to display organizational structure and hierarchy
4. Organize characters, settings, and outlines in Markdown documents; inspect references and review changes proposed by the assistant
5. Use **AI Scene Image** on key paragraphs: try different styles and “Refine scene with DeepSeek”; keep outputs in `scene_images` as chapter references or asset archives
6. Use the novel download feature: multi-source search, then download to local or export as TXT for reference and personal backup (please comply with copyright and local regulations)
7. Combine map design to build worldviews
   - Use shape tool to draw precise terrain boundaries
   - Use text tool to add place name annotations
   - Utilize resource icons to quickly build map elements
   - Use selection tool to adjust element positions and sizes
   - Utilize undo/redo functionality to optimize map details
8. Use random name generator to enrich characters
   - Configure DeepSeek API Key to enable AI intelligent naming
   - Use AI to generate names that match cultural backgrounds
   - Try generating different types and styles of names (ancient style, Japanese style, Western style, etc.)
   - Utilize batch generation feature to quickly screen suitable names
9. Set bookshelf password protection to ensure all data security
10. Use relationship graph avatar feature to enhance visual effects
11. Build a complete dictionary system, categorizing and managing proper nouns, place names, organizations, etc. in the story
12. Enable forbidden word detection in the editor to detect and mark sensitive vocabulary in real-time
13. Use character highlighting feature to quickly locate character appearances in text
14. View built-in user guide to learn more advanced features and tips

<span id="future-outlook"></span>
## 🔮 Future Outlook

As an open-source novel writing software, 51mazi has great development potential:

- **AI Feature Expansion**: Keep iterating on creative assistance beyond current capabilities
  - ✅ **AI Random Naming (DeepSeek)**: Multiple types and parameters; falls back to local generation on failure
  - ✅ **AI Polishing / AI Continuation (DeepSeek)**: Polish selection or whole chapter; continuation with optional instructions, insert at chapter end
  - ✅ **AI Novel Cover (Tongyi Wanxiang)**: Covers from title/pen name/style and size
- ✅ **Character Avatars**: The Markdown character workspace now supports image generation, candidate confirmation, saving the current text with its avatar, and refreshing linked relationship graph avatars
  - ✅ **AI Scene Image (Tongyi Wanxiang + optional DeepSeek)**: Scene art from selected text, saved to `scene_images`; optional prose-to-prompt refinement
  - 🔮 **AI Summarization**: Automatically generate chapter summaries
  - 🔮 **AI Dialogue Generation**: Generate character dialogues
  - 🔮 **AI Plot Suggestions**: Provide plot suggestions based on existing content
  - 🔮 **Outline Collaboration**: Continue improving Markdown outline organization and the change proposal workflow
- **Plugin System**: Support for third-party plugin extensions
- **Cloud Sync**: Optional cloud data synchronization
- **Collaboration Features**: Multi-user collaborative creation
- **Community Features**: Author communication platform

<span id="development-environment-setup"></span>
## 🚀 Development Environment Setup

### Install Dependencies
```bash
npm install
```

### Development Mode
```bash
npm run dev
```

### Build Package
```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

<span id="summary"></span>
## 📝 Summary

51mazi is a comprehensive and beautifully designed novel writing software that not only provides a professional writing environment but also integrates various creative assistance tools. Whether you're a novice author or an experienced creator, you can find a writing style that suits you in this software.

**Main Advantages**:
- ✅ Completely localized storage, protecting privacy
- ✅ Bookshelf password + book password dual protection, ensuring creative security
- ✅ Cross-platform support, convenient to use
- ✅ Comprehensive features, meeting various creative needs
- ✅ **AI-Assisted Creation**: DeepSeek naming/polish/continuation + Tongyi Wanxiang cover/scene image, improving creative efficiency
- ✅ Intelligent editor features (character highlighting, forbidden word detection, paragraph dragging)
- ✅ Professional map design tool with built-in resource library
- ✅ Dictionary management with flexible tree structure organization
- ✅ Smart operation experience, improving creative efficiency
- ✅ Download novels: multi-source search, add to bookshelf or export as TXT for reading and backup
- ✅ Beautiful interface with excellent user experience
- ✅ Built-in user guide for quick start
- ✅ Open source and free, continuously updated

If you're looking for a professional novel writing software, 51mazi is definitely worth trying. It can not only improve your creative efficiency but also make your creative process more interesting and organized.

---

### 📚 Related Links
- **Website**: [www.51mazi.com](https://www.51mazi.com)
- **Project Repository**: [GitHub - 51mazi](https://github.com/xiaoshengxianjun/51mazi)
- **Technology Stack**: Electron + Vue 3 + TipTap + Element Plus + Pinia + DeepSeek + Tongyi Wanxiang
- **Keywords**: Desktop Application, Rich Text Editing, Canvas Drawing, Relationship Graph, Novel Writing, Dictionary, Forbidden Word Detection, Character Highlighting, AI Assistance, AI Cover, AI Scene Image, Text-to-Image, AI Writing, Intelligent Naming, Markdown Knowledge Documents, Novel Download, Multi-source

<span id="contact--support"></span>
## 📞 Contact & Support

### Help Center / Business Cooperation

![QQ Group QR Code](static/QQQRCode.png)

- QQ Group: 777690109
- Issue Feedback / Business Cooperation Email: <fomazi@163.com>

### Sponsor the Author

Thank you to everyone who supports this project! You can support via:

| WeChat Pay | Alipay |
|------------|--------|
| ![WeChat Pay QR Code](static/WeChatPayQRCode.png) | ![Alipay QR Code](static/AliPayQRCode.png) |

<span id="tags"></span>
## 🏷️ Tags
`#Electron` `#Vue3` `#DesktopApplication` `#RichTextEditing` `#CanvasDrawing` `#RelationshipGraph` `#NovelWriting` `#KnowledgeDocuments` `#FrontendDevelopment` `#Dictionary` `#ForbiddenWordDetection` `#CharacterHighlighting` `#AIAssistance` `#AICovers` `#AISceneImage` `#TextToImage` `#AIWriting` `#TongyiWanxiang` `#DeepSeek` `#IntelligentNaming` `#NovelDownload`

---

*The 51mazi software introduced in this article is currently an open-source project. Developers interested in contributing are welcome. For more technical details and development information, please refer to the project's GitHub repository.*

> 💡 **If this article helps you, please give it a ⭐️!**
