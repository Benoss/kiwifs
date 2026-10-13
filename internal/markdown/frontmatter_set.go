package markdown

import (
	"bytes"
	"fmt"
	"time"

	yaml "go.yaml.in/yaml/v3"
)

// SetFrontmatterField sets a single key/value pair in the YAML frontmatter
// of a markdown document. If no frontmatter exists, one is created. The rest
// of the document body is preserved byte-for-byte.
//
// Only the lines of the changed key are rewritten: every other line keeps
// its bytes, comments and ordering, so retagging five hundred pages gives
// five hundred one-line diffs. The key keeps its flow or quote style and
// its inline comment. When the frontmatter is too unusual to splice safely
// (not a mapping, comments inside the value) the whole block is re-encoded.
//
// Supported value types: string, bool, int, float64, time.Time, slices and
// maps, nil (removes key). Returns the modified document content.
func SetFrontmatterField(content []byte, key string, value any) ([]byte, error) {
	if out, ok := spliceFrontmatterField(content, key, value); ok {
		return out, nil
	}
	return reencodeFrontmatterField(content, key, value)
}

// reencodeFrontmatterField is the fallback: parse, set, and encode the
// whole frontmatter block.
func reencodeFrontmatterField(content []byte, key string, value any) ([]byte, error) {
	fm, body, err := SplitFrontmatter(content)
	if err != nil {
		// Unterminated frontmatter — treat as no frontmatter.
		fm = nil
		body = content
	}

	// Parse existing frontmatter into an ordered map (preserve field order).
	var node yaml.Node
	if len(fm) > 0 {
		if err := yaml.Unmarshal(fm, &node); err != nil {
			// Corrupted YAML — start fresh but keep body.
			node = yaml.Node{}
		}
	}

	// Ensure we have a document node wrapping a mapping node.
	var mapping *yaml.Node
	if node.Kind == yaml.DocumentNode && len(node.Content) > 0 && node.Content[0].Kind == yaml.MappingNode {
		mapping = node.Content[0]
	} else {
		mapping = &yaml.Node{Kind: yaml.MappingNode}
		node = yaml.Node{
			Kind:    yaml.DocumentNode,
			Content: []*yaml.Node{mapping},
		}
	}

	// Convert value to a yaml.Node.
	valNode, err := valueToYAMLNode(value)
	if err != nil {
		return nil, fmt.Errorf("frontmatter set %q: %w", key, err)
	}

	// Find and replace existing key, or append.
	found := false
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			if value == nil {
				// Remove key-value pair.
				mapping.Content = append(mapping.Content[:i], mapping.Content[i+2:]...)
			} else {
				mapping.Content[i+1] = valNode
			}
			found = true
			break
		}
	}
	if !found && value != nil {
		mapping.Content = append(mapping.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Value: key},
			valNode,
		)
	}

	// Marshal the YAML back.
	var yamlBuf bytes.Buffer
	enc := yaml.NewEncoder(&yamlBuf)
	enc.SetIndent(0) // flat frontmatter style (no extra indentation)
	if err := enc.Encode(&node); err != nil {
		return nil, fmt.Errorf("frontmatter marshal: %w", err)
	}
	enc.Close()

	// yaml.Encoder appends a trailing "...\n" or newline — strip it.
	yamlBytes := bytes.TrimRight(yamlBuf.Bytes(), "\n")
	// Also strip trailing "..." document end marker if present.
	yamlBytes = bytes.TrimSuffix(yamlBytes, []byte("\n..."))
	yamlBytes = bytes.TrimSuffix(yamlBytes, []byte("..."))
	yamlBytes = bytes.TrimRight(yamlBytes, "\n")

	// Reconstruct the document: ---\n<yaml>\n---\n<body>
	var out bytes.Buffer
	out.WriteString("---\n")
	out.Write(yamlBytes)
	out.WriteString("\n---\n")
	if len(body) > 0 {
		out.Write(body)
	}
	return out.Bytes(), nil
}

// valueToYAMLNode converts a Go value to an appropriate yaml.Node for
// frontmatter serialization.
func valueToYAMLNode(v any) (*yaml.Node, error) {
	if v == nil {
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}, nil
	}
	switch val := v.(type) {
	case bool:
		s := "false"
		if val {
			s = "true"
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: s}, nil
	case string:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: val}, nil
	case int:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: fmt.Sprintf("%d", val)}, nil
	case float64:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!float", Value: fmt.Sprintf("%g", val)}, nil
	case time.Time:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!timestamp", Value: val.UTC().Format(time.RFC3339)}, nil
	default:
		// Fallback: marshal then unmarshal to get a node.
		data, err := yaml.Marshal(val)
		if err != nil {
			return nil, err
		}
		var n yaml.Node
		if err := yaml.Unmarshal(data, &n); err != nil {
			return nil, err
		}
		if n.Kind == yaml.DocumentNode && len(n.Content) > 0 {
			return n.Content[0], nil
		}
		return &n, nil
	}
}
