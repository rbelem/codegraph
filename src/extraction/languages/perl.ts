import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Perl Tree-sitter Extractor
 *
 * Maps the Perl grammar (tree-sitter-perl, ABI 14, from @lumis-sh/wasm-perl) AST
 * to CodeGraph's unified node/edge representation.
 *
 * Key Perl AST node types:
 *   - package_statement: package declaration (acts as namespace/module)
 *   - subroutine_declaration_statement: sub definitions
 *   - use_statement: use Module (import)
 *   - require_expression: require 'file' or require Module (import)
 *   - function_call_expression / ambiguous_function_call_expression: function calls
 *   - method_call_expression: $obj->method() calls
 *   - variable_declaration: my $var, my ($x, $y)
 *   - func1op_call_expression: single-arg op-like calls (shift, bless...)
 *
 * Variable extraction is handled in the core extractVariable (tree-sitter.ts)
 * via a dedicated `perl` branch (Perl's variable_declaration → scalar → varname
 * doesn't match the generic fallback).
 */

export const perlExtractor: LanguageExtractor = {
  // Subroutine declarations — Perl's only function-like construct
  functionTypes: ['subroutine_declaration_statement'],
  classTypes: [],
  // Methods are just subs in a package; no distinct AST node
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  // Imports handled via visitNode (use_statement, require_expression)
  importTypes: [],
  callTypes: [
    'function_call_expression',
    'ambiguous_function_call_expression',
    'method_call_expression',
    'func1op_call_expression',
  ],
  variableTypes: ['variable_declaration'],

  // Field name mappings
  nameField: 'name',
  bodyField: 'body',
  paramsField: '', // Perl has no formal params in AST (uses @_)

  /**
   * Extract signature: Perl subs have no formal params syntax in tree-sitter,
   * so just return "()" to indicate it's callable.
   */
  getSignature: (_node, _source) => {
    return '()';
  },

  /**
   * Custom node visitor for Perl-specific constructs:
   *   1. package_statement → module node (with scope management)
   *   2. use_statement / require_expression → import nodes
   */
  visitNode: (node, ctx) => {
    const source = ctx.source;

    // --- Package declarations (namespaces/modules) ---
    if (node.type === 'package_statement') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return false;
      const name = getNodeText(nameNode, source);

      const pkgNode = ctx.createNode('module', name, node);
      if (!pkgNode) return false;

      // Push package onto scope so subsequent subs get qualified names
      ctx.pushScope(pkgNode.id);

      // Visit package body if it has one (scoped package syntax)
      const body = node.namedChildren.find((c: SyntaxNode) => c.type === 'block');
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) ctx.visitNode(child);
        }
      }

      ctx.popScope();
      return true;
    }

    // --- use Module (import) ---
    if (node.type === 'use_statement') {
      const moduleNode = node.childForFieldName('module');
      if (!moduleNode) return false;
      const moduleName = getNodeText(moduleNode, source);

      ctx.createNode('import', moduleName, node, {
        signature: source.substring(node.startIndex, node.endIndex).trim().slice(0, 100),
      });

      // Track as unresolved reference for resolution
      if (ctx.nodeStack.length > 0) {
        const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (parentId) {
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: moduleName,
            referenceKind: 'imports',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
      return true;
    }

    // --- require Module or require 'file' (import) ---
    if (node.type === 'require_expression') {
      let importName: string | null = null;

      // Check for bareword (require Module)
      const bareword = node.namedChildren.find((c: SyntaxNode) => c.type === 'bareword');
      if (bareword) {
        importName = getNodeText(bareword, source);
      }

      // Check for string literal (require "file.pl")
      if (!importName) {
        const strContent = node.namedChildren.find(
          (c: SyntaxNode) => c.type === 'string_literal' || c.type === 'interpolated_string_literal'
        );
        if (strContent) {
          const content = strContent.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
          if (content) {
            importName = getNodeText(content, source);
          }
        }
      }

      if (importName) {
        ctx.createNode('import', importName, node, {
          signature: source.substring(node.startIndex, node.endIndex).trim().slice(0, 100),
        });

        if (ctx.nodeStack.length > 0) {
          const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
          if (parentId) {
            ctx.addUnresolvedReference({
              fromNodeId: parentId,
              referenceName: importName,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
      }
      return true;
    }

    return false;
  },
};
