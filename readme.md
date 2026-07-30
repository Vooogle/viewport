![Hero](https://github.com/Vooogle/viewport/blob/main/readme/hero_0.png?raw=true)

## What is it

- Simple UI/UX Video Editor
- Fully AI slop disclaimer (because i suck at this)

## Why?

I got tired of video editors being really annoying to use, it was acting as a barrier from me wanting to make videos so i decided to take what i liked on most and build off it.

![Screenshot](https://github.com/Vooogle/viewport/blob/main/readme/screenshot_0.png?raw=true)

## UI

There are 3 main parts of the UI

- Red - Toolbars
- Green - Topbar
- Purple - Content Panels

Toolbars can be moved around and so can be tools to fit your preference, saveable in View > Layout > Save Layout

![UI Colorcoded](https://github.com/Vooogle/viewport/blob/main/readme/ui_colorcoded.png?raw=true)

You can also customize the colors of the UI, Dark Mode, Light Mode and Custom Colors in File > Preferences > General

## Editor

Alright so in the editor itself we have 3 main panels

- red - Tool Panel
- green - Viewport/Preview
- purple - Timeline

Tool Panel (marked in red) will propogate most regular tool settings to it.  
Timeline will show you the actual contents of your edit.  
Preview will show you what you are editing and can also act as a visual editing space to move stuff around the viewport.

![Content Colorcoded](https://github.com/Vooogle/viewport/blob/main/readme/content_colorcoded.png?raw=true)

## Preview / Viewport

Alright so the preview is what your video will actually look like.
The viewport space is a 3d area, to support full rotation and moving of objects around, to offer more capabilities to your edit.

When clicking on the viewport on an object the object can be moved around and when you click again cycle through options, those being

- Transform
- Rotate
- 3D Move

all of which add handles for easier editing.

![Screenshot](https://github.com/Vooogle/viewport/blob/main/readme/screenshot_2.png?raw=true)

CTRL can help you have more control and add limits when changing stuff around, shift usually loosens restrictions.

## Timeline

The timeline lets you actually create your edit.
You add your assets to the timeline, move them where they are needed.
Keep in mind the track thats highest will render above, you can reorder the tracks at any time.

![Screenshot](https://github.com/Vooogle/viewport/blob/main/readme/screenshot_5.png?raw=true)

### Movement

For moving around the ruler you have many options.  
Scroll-Wheel on the ruler will by default move you back and forward on the timeline.  
Shift + Scroll-wheel will move the playhead back and forward on the timeline.  
Arrow keys will move the playhead 5s back and forward.  
CTRL + arrow keys will move the playhead frame by frame.  
CTRL + Shift + arrow keys will move the playhead to the current objects start or end.

### The Ruler

The Ruler is unchanging in size, but the distance between the segments can be modified via the choices on the top right of the timeline.
You are able to switch between second and frames and change the amount between segments.
You can also click on the segments to snap your playhead to them.
CTRL + Scroll-wheel will change the ruler segments for if you need a closer edit or want to see the entire project.

### Editing
By default S key will cut selected object to your playhead.  
Shift S will cut all objects to your playhead.  
You can drag on the edge handles of objects on the timeline to cut their beginning and end.

### Animating

Animating is important, i took heavy inspiration from [Blockbench](https://www.blockbench.net/) because their animation workflow is very simple and intuitive.

![Screenshot](https://github.com/Vooogle/viewport/blob/main/readme/screenshot_6.png?raw=true)

To begin animating simply right click on any object in the timeline and press Animate.

Once your in this animate screen you will have only the selected object on the timeline.

Any edits made while animation timeline is open will create a new keyframe including in the Properties tool or the Viewport.

You can pick through 4 animation types

- Linear - Moves at the same rate to the next keyframe
- Smooth - curves out the ends so they don't end as jarringly.
- Bezier - Basically a controlled smooth toggle graph mode to move handles and mess around with it more.
- Step - Will not smoothly move, it will jump from keyframe to keyframe.

## Tools

There are currently 3 main tools

- Files Tool - lets you import files
- Properties Tool - lets you change object values
- Text Tool - lets you create text objects

Access these tools from the toolbar.

![Screenshot](https://github.com/Vooogle/viewport/blob/main/readme/screenshot_1.png?raw=true)

## Exporting

Exporting is the only button on the right tool bar, or utility bar as i call it.
it exports your video.

![Screenshot](https://github.com/Vooogle/viewport/blob/main/readme/screenshot_7.png?raw=true)

## Test Edits

Minecraft Cow Kill Test
[![Test Edits](https://img.youtube.com/vi/JTlrB_zgNL8/maxresdefault.jpg)](https://youtu.be/JTlrB_zgNL8)

## Operating Systems

I have currently only tested it on Windows 11.
Linux and MacOS will be buggier and probably slower as i haven't built the export out for them yet.
