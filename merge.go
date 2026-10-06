package main

import (
	"bytes"
	stdjson "encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"github.com/sagernet/sing/common/json"
)

// A subscription updated over a profile the user changed merges three
// ways: from the source it was (base), what changed upstream (theirs) and
// what the user changed (mine) both stay. Where both changed the same
// thing differently, the user's change stays, and the place is reported.

// object is a JSON object that keeps its keys in order, so that the
// merged profile reads as the subscription does.
type object struct {
	keys []string
	vals map[string]any
}

// missing stands for a key or tagged item that one side does not have.
type missingValue struct{}

var missing = missingValue{}

// decodeOrdered reads JSON, comments allowed, keeping the order of keys.
func decodeOrdered(content []byte) (any, error) {
	plain, err := io.ReadAll(json.NewCommentFilter(bytes.NewReader(content)))
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(plain)) == 0 {
		return nil, errors.New("内容是空的")
	}
	d := stdjson.NewDecoder(bytes.NewReader(dropTrailingCommas(plain)))
	d.UseNumber()
	v, err := decodeValue(d)
	if err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, errors.New("JSON 之后还有多余的内容")
	}
	return v, nil
}

// dropTrailingCommas removes the commas before a closing bracket, which
// the core accepts and the standard decoder does not; strings are left.
func dropTrailingCommas(b []byte) []byte {
	out := make([]byte, 0, len(b))
	inString, escaped := false, false
	for i := 0; i < len(b); i++ {
		c := b[i]
		if inString {
			out = append(out, c)
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		if c == '"' {
			inString = true
		}
		if c == ',' {
			j := i + 1
			for j < len(b) && (b[j] == ' ' || b[j] == '\t' || b[j] == '\n' || b[j] == '\r') {
				j++
			}
			if j < len(b) && (b[j] == '}' || b[j] == ']') {
				continue
			}
		}
		out = append(out, c)
	}
	return out
}

func decodeValue(d *stdjson.Decoder) (any, error) {
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch t {
	case stdjson.Delim('{'):
		o := &object{vals: map[string]any{}}
		for d.More() {
			k, err := d.Token()
			if err != nil {
				return nil, err
			}
			key, _ := k.(string)
			v, err := decodeValue(d)
			if err != nil {
				return nil, err
			}
			if _, seen := o.vals[key]; !seen {
				o.keys = append(o.keys, key)
			}
			o.vals[key] = v
		}
		_, err := d.Token()
		return o, err
	case stdjson.Delim('['):
		list := []any{}
		for d.More() {
			v, err := decodeValue(d)
			if err != nil {
				return nil, err
			}
			list = append(list, v)
		}
		_, err := d.Token()
		return list, err
	}
	return t, nil
}

// encodeOrdered writes JSON indented by two spaces, keys in order.
func encodeOrdered(v any) []byte {
	var b bytes.Buffer
	writeValue(&b, v, "")
	b.WriteByte('\n')
	return b.Bytes()
}

func writeValue(b *bytes.Buffer, v any, indent string) {
	switch v := v.(type) {
	case *object:
		if len(v.keys) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{\n")
		for i, k := range v.keys {
			b.WriteString(indent + "  ")
			writeScalar(b, k)
			b.WriteString(": ")
			writeValue(b, v.vals[k], indent+"  ")
			if i < len(v.keys)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent + "}")
	case []any:
		if len(v) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, x := range v {
			b.WriteString(indent + "  ")
			writeValue(b, x, indent+"  ")
			if i < len(v)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent + "]")
	default:
		writeScalar(b, v)
	}
}

func writeScalar(b *bytes.Buffer, v any) {
	var out bytes.Buffer
	e := stdjson.NewEncoder(&out)
	e.SetEscapeHTML(false)
	e.Encode(v)
	b.Write(bytes.TrimRight(out.Bytes(), "\n"))
}

// equalJSON compares two decoded values; the order of keys aside.
func equalJSON(a, b any) bool {
	oa, aok := a.(*object)
	ob, bok := b.(*object)
	if aok || bok {
		if !aok || !bok || len(oa.keys) != len(ob.keys) {
			return false
		}
		for _, k := range oa.keys {
			bv, ok := ob.vals[k]
			if !ok || !equalJSON(oa.vals[k], bv) {
				return false
			}
		}
		return true
	}
	la, aok := a.([]any)
	lb, bok := b.([]any)
	if aok || bok {
		if !aok || !bok || len(la) != len(lb) {
			return false
		}
		for i := range la {
			if !equalJSON(la[i], lb[i]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(a, b)
}

// mergeConfig merges a profile three ways. It returns the merged text,
// and the places where both sides changed, kept as mine.
func mergeConfig(base, theirs, mine []byte) ([]byte, []string, error) {
	b, err := decodeOrdered(base)
	if err != nil {
		return nil, nil, fmt.Errorf("读取原来的订阅内容：%w", err)
	}
	t, err := decodeOrdered(theirs)
	if err != nil {
		return nil, nil, fmt.Errorf("读取下载的订阅内容：%w", err)
	}
	m, err := decodeOrdered(mine)
	if err != nil {
		return nil, nil, fmt.Errorf("读取本机修改后的配置：%w", err)
	}
	switch {
	case equalJSON(b, m):
		// Nothing changed here: the download as it is, comments and all.
		return theirs, nil, nil
	case equalJSON(b, t):
		// Nothing changed upstream.
		return mine, nil, nil
	}
	var conflicts []string
	merged := merge3(b, t, m, "", &conflicts)
	return encodeOrdered(merged), conflicts, nil
}

func merge3(b, t, m any, path string, conflicts *[]string) any {
	switch {
	case equalJSON(t, m):
		return t
	case equalJSON(b, m):
		return t
	case equalJSON(b, t):
		return m
	}
	ob, okb := b.(*object)
	ot, okt := t.(*object)
	om, okm := m.(*object)
	if okt && okm {
		if !okb {
			ob = &object{vals: map[string]any{}}
		}
		return mergeObjects(ob, ot, om, path, conflicts)
	}
	lt, okt := t.([]any)
	lm, okm := m.([]any)
	if okt && okm {
		lb, _ := b.([]any)
		if tagged(lb) && tagged(lt) && tagged(lm) {
			return mergeTagged(lb, lt, lm, path, conflicts)
		}
	}
	*conflicts = append(*conflicts, displayPath(path))
	return m
}

func mergeObjects(b, t, m *object, path string, conflicts *[]string) any {
	out := &object{vals: map[string]any{}}
	put := func(k string, v any) {
		if v == missing {
			return
		}
		if _, ok := out.vals[k]; !ok {
			out.keys = append(out.keys, k)
		}
		out.vals[k] = v
	}
	get := func(o *object, k string) any {
		if v, ok := o.vals[k]; ok {
			return v
		}
		return missing
	}
	// Their order, then the keys only mine has.
	for _, k := range t.keys {
		put(k, merge3(get(b, k), get(t, k), get(m, k), join(path, k), conflicts))
	}
	for _, k := range m.keys {
		if _, ok := t.vals[k]; !ok {
			put(k, merge3(get(b, k), missing, get(m, k), join(path, k), conflicts))
		}
	}
	return out
}

// tagged reports whether a list is of objects named by unique tags, as
// outbounds are: merged by tag rather than by place.
func tagged(list []any) bool {
	seen := map[string]bool{}
	for _, x := range list {
		o, ok := x.(*object)
		if !ok {
			return false
		}
		tag, ok := o.vals["tag"].(string)
		if !ok || tag == "" || seen[tag] {
			return false
		}
		seen[tag] = true
	}
	return true
}

func mergeTagged(b, t, m []any, path string, conflicts *[]string) any {
	byTag := func(list []any) (map[string]any, []string) {
		out, order := map[string]any{}, []string{}
		for _, x := range list {
			tag := x.(*object).vals["tag"].(string)
			out[tag], order = x, append(order, tag)
		}
		return out, order
	}
	bm, _ := byTag(b)
	tm, torder := byTag(t)
	mm, morder := byTag(m)
	get := func(set map[string]any, tag string) any {
		if v, ok := set[tag]; ok {
			return v
		}
		return missing
	}
	// In mine's order, as the user may have arranged it; an item new
	// upstream goes after the one it follows there.
	order := slices.Clone(morder)
	for i, tag := range torder {
		if _, ok := mm[tag]; ok {
			continue
		}
		at := 0
		for j := i - 1; j >= 0; j-- {
			if k := slices.Index(order, torder[j]); k >= 0 {
				at = k + 1
				break
			}
		}
		order = slices.Insert(order, at, tag)
	}
	out := []any{}
	for _, tag := range order {
		theirs, ok := tm[tag]
		if !ok {
			theirs = missing
		}
		if v := merge3(get(bm, tag), theirs, get(mm, tag), path+"["+strconv.Quote(tag)+"]", conflicts); v != missing {
			out = append(out, v)
		}
	}
	return out
}

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func displayPath(path string) string {
	if path == "" {
		return "整份配置"
	}
	return strings.ReplaceAll(path, `"`, "")
}
