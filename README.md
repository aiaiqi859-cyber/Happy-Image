# Happy-Image

Happy-Image is a smart image generation plugin for SillyTavern that leverages AI to automatically create and embed images in your conversations. This plugin features a sophisticated three-tier API architecture:

- API1: Primary API for chatting with users (not involved in image generation)
- API2: Separate LLM for generating detailed image prompts based on conversation content
- API3: Tavern-integrated image generation model for creating and inserting images

## Features

- **Smart Image Generation**: Three-tiered approach to intelligently process conversations and generate matching images
- **Flexible Trigger Options**: Choose from manual (floating button), keyword detection, or auto-generation
- **Multiple API Configurations**: Three ways to set up LLM for prompt generation:
  - Use Tavern's current API
  - Use predefined connection presets
  - Use custom API endpoint configuration
- **Bilingual Prompts**: Images generated with both English (for generation) and Chinese (for commentary) prompts
- **Multiple Insertion Methods**: Choose to insert images at various positions:
  - Replace triggered text
  - End of message 
  - Beginning of message
  - New message entirely
- **Customizable Prompt Templates**: Edit the LLM prompt template to customize how image prompts are generated
- **Comprehensive Logging**: Detailed debugging logs for development and troubleshooting

## Installation

1. Place the Happy-Image folder in your SillyTavern `scripts/extensions/third-party` directory
2. Enable the extension in your SillyTavern extensions settings

## Configuration

### General Settings

- Enable/Disable the plugin
- Select Task Trigger Mode (Manual, Keyword, Auto)
- Set keyword list (for keyword-triggered mode)
  - Keywords should be comma-separated (e.g., "image, pic, art")

### API2 Configuration (For Generating Prompts)

Choose your prompt generation API source:

1. **Use Tavern's Main API**: Use SillyTavern's currently configured API for prompt creation
2. **Use Connection Preset**: Select from predefined API configurations (coming soon)
3. **Custom Configuration**: Configure with:
   - API URL
   - API Key
   - Model name

### Prompt Template (For LLM Configuration)

Edit the system prompt that's sent to API2 with conversation content. This template controls:

- How the LLM processes the incoming message
- What information to include in generated image prompts
- Output format of JSON containing English/Chinese prompts and position information

Default template includes English and Chinese prompt pairs along with positioning data.

### Insertion Settings

Choose how your generated images will embed in the chat:

- **Replace Keyword/Trigger**: Replaces the original trigger phrase with image (default)
- **End of Message**: Appends to end of AI message
- **New Message**: Creates new AI message containing just the image
- **Beginning of Message**: Inserts at start of message with generated content moved after

### Image Saving (Browser Security Limitations)

- **Enable Saving**: Allows browser to attempt downloading images to a local folder (not possible due to browser security restrictions; included for future implementation)
- When possible, saves with character-name-based subfolder organization

### Debug Settings

- Enable/Disable debug logs
- Select detail level: debug, info, warn, or error
- Enable toast notifications for status updates

## Development & Testing

To ensure your image generation is working:
1. Configure your Tavern SD integration properly
2. Set the API2 for prompt generation with a working language model
3. Set trigger to "keyword" and enter relevant words in your chat
4. Look for images in your chat UI

This plugin was created with functionality based on the similar `st-image-auto-generation-main` and `Engram-master` projects for reference implementation.
