package main

import (
	_ "embed"
	stdjson "encoding/json"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strconv"
	"sync"

	"github.com/sagernet/sing/common/json"
)

// The schema of the configuration, as the core's docs/schema.json has it
// (tools/configschema copies it). Fields that name another part of the
// configuration by its tag carry "x-tag-reference": the kind of tag.
//
//go:embed frontend/src/config/gen/schema.json
var schemaJSON []byte

type schemaNode = map[string]any

var configSchema = sync.OnceValue(func() schemaNode {
	var s schemaNode
	if err := stdjson.Unmarshal(schemaJSON, &s); err != nil {
		panic(err)
	}
	return s
})

// Problem is a part of a configuration that the core would refuse, found
// without building it: a reference to a tag nothing has.
type Problem struct {
	// Path is where, as route.rules[2].rule_set[0].
	Path    string `json:"path"`
	Message string `json:"message"`
	// Fatal is whether the core would refuse to start. A missing inbound
	// only makes a rule match nothing.
	Fatal bool `json:"fatal"`
}

// tagKinds are the kinds of tags, in the app's words.
var tagKinds = map[string]string{
	"outbound":             "出站",
	"inbound":              "入站",
	"rule_set":             "规则集",
	"dns_server":           "DNS 服务器",
	"certificate_provider": "证书提供者",
	"http_client":          "HTTP 客户端",
	"network_namespace":    "网络命名空间",
}

// tagSections are where the tags of each kind are defined. Endpoints are
// outbounds and inbounds both.
var tagSections = []struct {
	path  []string
	kinds []string
}{
	{[]string{"inbounds"}, []string{"inbound"}},
	{[]string{"outbounds"}, []string{"outbound"}},
	{[]string{"endpoints"}, []string{"outbound", "inbound"}},
	{[]string{"dns", "servers"}, []string{"dns_server"}},
	{[]string{"route", "rule_set"}, []string{"rule_set"}},
	{[]string{"certificate_providers"}, []string{"certificate_provider"}},
	{[]string{"http_clients"}, []string{"http_client"}},
	{[]string{"network_namespaces"}, []string{"network_namespace"}},
}

// rawJSON decodes a configuration as written, comments allowed, without
// the defaults and the normal forms the core reads it into: paths into it
// are paths into the file. It is nil when it does not decode.
func rawJSON(content []byte) map[string]any {
	root, err := json.UnmarshalExtended[map[string]any](content)
	if err != nil {
		return nil
	}
	return root
}

// checkReferences finds the references of a configuration, in plain JSON,
// to tags that nothing defines, and tags defined twice. The core finds
// some of these only once started.
func checkReferences(root map[string]any) []Problem {
	if root == nil {
		return nil
	}
	c := &refChecker{defs: map[string]schemaNode{}, tags: map[string]map[string]bool{}}
	if defs, ok := configSchema()["$defs"].(map[string]any); ok {
		for k, v := range defs {
			c.defs[k], _ = v.(schemaNode)
		}
	}
	c.collect(root)
	c.walk(root, configSchema(), "")
	// A string the schema does not mark.
	if route, ok := root["route"].(map[string]any); ok {
		if tag, _ := route["default_http_client"].(string); tag != "" {
			c.check("http_client", tag, "route.default_http_client")
		}
	}
	return c.problems
}

type refChecker struct {
	defs     map[string]schemaNode
	tags     map[string]map[string]bool
	problems []Problem
}

func (c *refChecker) add(kind, tag string) {
	if c.tags[kind] == nil {
		c.tags[kind] = map[string]bool{}
	}
	c.tags[kind][tag] = true
}

// collect gathers the tags defined. Without a tag, the core names an
// item by its index.
func (c *refChecker) collect(root map[string]any) {
	seen := map[string]string{}
	for _, section := range tagSections {
		items, _ := lookup(root, section.path).([]any)
		for i, it := range items {
			obj, _ := it.(map[string]any)
			var tags []string
			switch t := obj["tag"].(type) {
			case string:
				tags = []string{t}
			case []any:
				for _, x := range t {
					if s, ok := x.(string); ok {
						tags = append(tags, s)
					}
				}
			}
			if len(tags) == 0 || (len(tags) == 1 && tags[0] == "") {
				tags = []string{strconv.Itoa(i)}
			}
			for _, tag := range tags {
				kind := section.kinds[0]
				path := fmt.Sprintf("%s[%d].tag", joinPath(section.path), i)
				if first, ok := seen[kind+"\x00"+tag]; ok {
					c.problems = append(c.problems, Problem{Path: path, Message: fmt.Sprintf("%s标签“%s”重复，%s 已经用过", tagKinds[kind], tag, first), Fatal: true})
				} else {
					seen[kind+"\x00"+tag] = path
				}
				for _, k := range section.kinds {
					c.add(k, tag)
				}
			}
		}
	}
	// Without outbounds, the core adds a direct one, unless the final
	// outbound is an endpoint; without DNS servers, a local one.
	if implicitDirect(root) {
		c.add("outbound", "direct")
	}
	if len(c.tags["dns_server"]) == 0 {
		c.add("dns_server", "local")
	}
}

// implicitDirect reports whether the core adds a direct outbound: there
// are no outbounds, and route.final does not name an endpoint instead.
func implicitDirect(root map[string]any) bool {
	if outbounds, _ := lookup(root, []string{"outbounds"}).([]any); len(outbounds) > 0 {
		return false
	}
	final, _ := lookup(root, []string{"route", "final"}).(string)
	if final == "" {
		return true
	}
	endpoints, _ := lookup(root, []string{"endpoints"}).([]any)
	for _, it := range endpoints {
		if obj, _ := it.(map[string]any); obj["tag"] == final {
			return false
		}
	}
	return true
}

func (c *refChecker) check(kind, tag, path string) {
	if tag == "" || c.tags[kind][tag] {
		return
	}
	name := tagKinds[kind]
	if name == "" {
		name = kind
	}
	if kind == "inbound" {
		c.problems = append(c.problems, Problem{Path: path, Message: fmt.Sprintf("引用的%s“%s”不存在，不影响启动，但它不会匹配任何连接", name, tag)})
		return
	}
	c.problems = append(c.problems, Problem{Path: path, Message: fmt.Sprintf("引用的%s“%s”不存在", name, tag), Fatal: true})
}

func (c *refChecker) resolve(s schemaNode) schemaNode {
	for i := 0; s != nil && i < 32; i++ {
		ref, ok := s["$ref"].(string)
		if !ok {
			return s
		}
		const prefix = "#/$defs/"
		if len(ref) <= len(prefix) {
			return nil
		}
		s = c.defs[ref[len(prefix):]]
	}
	return s
}

// walk follows a value along its schema, checking every reference.
func (c *refChecker) walk(v any, s schemaNode, path string) {
	s = c.resolve(s)
	if s == nil {
		return
	}
	if kind, ok := s["x-tag-reference"].(string); ok {
		if tag, ok := v.(string); ok {
			c.check(kind, tag, path)
		}
	}
	for _, sub := range nodes(s["allOf"]) {
		c.walk(v, sub, path)
	}
	for _, key := range []string{"oneOf", "anyOf"} {
		if branch := c.choose(v, nodes(s[key])); branch != nil {
			c.walk(v, branch, path)
		}
	}
	switch v := v.(type) {
	case map[string]any:
		props, _ := s["properties"].(map[string]any)
		for _, k := range slices.Sorted(maps.Keys(v)) {
			if ps, ok := props[k].(schemaNode); ok {
				c.walk(v[k], ps, joinKey(path, k))
			}
		}
	case []any:
		if items, ok := s["items"].(schemaNode); ok {
			for i, val := range v {
				c.walk(val, items, fmt.Sprintf("%s[%d]", path, i))
			}
		}
	}
}

// choose returns the first branch a value fits: by its JSON type, and
// for objects by the fields a branch fixes, as type or action.
func (c *refChecker) choose(v any, branches []schemaNode) schemaNode {
	for _, b := range branches {
		if c.fits(v, b) {
			return b
		}
	}
	return nil
}

func (c *refChecker) fits(v any, s schemaNode) bool {
	s = c.resolve(s)
	if s == nil {
		return false
	}
	if t, ok := s["type"].(string); ok && !jsonTypeIs(v, t) {
		return false
	}
	if want, ok := s["const"]; ok && !sameJSON(v, want) {
		return false
	}
	for _, sub := range nodes(s["allOf"]) {
		if !c.fits(v, sub) {
			return false
		}
	}
	for _, key := range []string{"oneOf", "anyOf"} {
		if list := nodes(s[key]); len(list) > 0 && c.choose(v, list) == nil {
			return false
		}
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return true
	}
	props, _ := s["properties"].(map[string]any)
	required := map[string]bool{}
	if r, ok := s["required"].([]any); ok {
		for _, k := range r {
			if name, ok := k.(string); ok {
				required[name] = true
			}
		}
	}
	for k, p := range props {
		ps, _ := p.(schemaNode)
		want, hasConst := ps["const"]
		enum, hasEnum := ps["enum"].([]any)
		if !hasConst && !hasEnum {
			continue
		}
		val, present := obj[k]
		if !present {
			if required[k] {
				return false
			}
			continue
		}
		if hasConst && !sameJSON(val, want) {
			return false
		}
		if hasEnum && !inEnum(val, enum) {
			return false
		}
	}
	return true
}

func nodes(v any) []schemaNode {
	list, _ := v.([]any)
	out := make([]schemaNode, 0, len(list))
	for _, it := range list {
		if n, ok := it.(schemaNode); ok {
			out = append(out, n)
		}
	}
	return out
}

func jsonTypeIs(v any, t string) bool {
	switch v := v.(type) {
	case map[string]any:
		return t == "object"
	case []any:
		return t == "array"
	case string:
		return t == "string"
	case bool:
		return t == "boolean"
	case float64:
		return t == "number" || (t == "integer" && v == float64(int64(v)))
	case nil:
		return t == "null"
	}
	return false
}

func sameJSON(a, b any) bool { return reflect.DeepEqual(a, b) }

func inEnum(v any, enum []any) bool {
	for _, e := range enum {
		if sameJSON(v, e) {
			return true
		}
	}
	return false
}

func lookup(root map[string]any, path []string) any {
	var cur any = root
	for _, k := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[k]
	}
	return cur
}

func joinPath(path []string) string {
	out := ""
	for _, k := range path {
		out = joinKey(out, k)
	}
	return out
}

func joinKey(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}
